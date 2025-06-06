import puppeteer from 'puppeteer';
import locale from 'date-fns/locale/it/index.js';
import parse from 'date-fns/parse/index.js';
import differenceInCalendarDays from 'date-fns/differenceInCalendarDays/index.js';

const CUP_URL = 'https://cup.isan.csi.it/web/guest/ricetta-dematerializzata';

/**
 * Reserve
 * @param cf
 * @param ricetta
 * @param maxDays
 * @param zipFilter
 * @param addressFilter
 * @returns {Promise<{appuntamenti: [{date: Date, address: string, isGoodDate: boolean, isGoodPlace: boolean}], confirmed: {date: Date, address: string, isGoodDate: boolean, isGoodPlace: boolean}, images: [Buffer], info: string, cf: string, ricetta: string, chatId: string}>}
 */
async function reserve({ chatId, cf, ricetta, maxDays = 30, zipFilter = '101[0-9][0-9]', addressFilter = '.*' }) {
  // console.log(`Cerco di prenotare ${cf} ${ricetta} ${phone} ${email} tentativo ${counter}`);
  const result = {
    info: undefined,
    found: undefined,
    confirmed: undefined,
    error: undefined,
    appuntamenti: [],
    images: [],
    cf,
    ricetta,
    chatId
  };
  const browser = await puppeteer.launch({
    // headless: false,
    headless: 'new',
    args: [`--window-size=1920,1080`, '--no-sandbox', "--disabled-setupid-sandbox"],
    defaultViewport: { width: 1920, height: 1080 },
  });
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(2 * 60_000);
  page.setDefaultTimeout(2 * 60_000);

  async function checkAndClickSelector(selector, counter = 0) {
    if (result.error) {
      return false;
    }
    // try {
    //   await page.waitForSelector(selector, { timeout: 10_000 });
    // } catch(error) {
    //   return false;
    // }
    await new Promise((r) => setTimeout(r, 10_000));
    const [selectorFound] = await page.$$(selector);
    if (selectorFound) {
      await page.click(selector);
      await new Promise((r) => setTimeout(r, 10_000));
    }
    const [warning] = await page.$$('.messagifyMsg.alert-danger span');
    if (warning && counter < 5) {
      return checkAndClickSelector(selector, counter + 1)
    } else if (warning && counter >= 5) {
      const message = await warning?.evaluate((el) => el.textContent);
      console.log(`${ricetta} errore ${message}`)
      result.error = message;
      result.images.push(await page.screenshot({ fullPage: true }));
      await browser.close();
      if (browser && browser.process() != null) {
        browser.process().kill('SIGINT');
      }
    }
    return true;
  }

  // PAGE 1 (insert cf+prenotazione)
  await page.goto(CUP_URL, { waitUntil: 'networkidle2' });
  await page.$eval('input.codice-fiscale-bt', (el, value) => (el.value = value), cf);
  await page.$eval('input.nreInput-bt', (el, value) => (el.value = value), ricetta);
  await new Promise((r) => setTimeout(r, 2_000));
  await checkAndClickSelector('span[aria-describedby="Avanti"],span[aria-describedby="Prosegui"] button');
  if (result.error) {
    return result;
  }

  // PAGE 2 (confirm)
  console.log(`${ricetta} page 2`)
  const infos = await page.$$('.prestazioneRow .infoValue');
  const info = await infos[2]?.evaluate((el) => el.textContent);
  result.info = `${info}\n`;
  await checkAndClickSelector('span[aria-describedby="Avanti"],span[aria-describedby="Prosegui"] button');

  // PAGE 3 (appointments)
  await page.waitForSelector('[name="_ricettaelettronica_WAR_cupprenotazione_:appuntamentiForm"],.no-available');
  console.log(`${ricetta} page 3`)
  result.images.push(await page.screenshot({ fullPage: true }));
  await checkAndClickSelector('span[aria-describedby="Altre disponibilità"] button');
  await page.waitForSelector('#availableAppointmentsBlock');
  result.images.push(await page.screenshot({ fullPage: true }));
  const appuntamenti = await page.$$('#availableAppointmentsBlock .appuntamento');
  for (const [i, appuntamento] of appuntamenti.entries()) {
    const data = (await appuntamento.$eval('.captionAppointment-dateApp', (el) => el.textContent))
      .replace(/\n\t*/, '')
      .replace('alle ore', ' ');
    const address = (await appuntamento.$eval('.captionAppointment-address', (el) => el.getAttribute('data-address')))
      .replace('\n', '')
      .replace('null', 'N/A');
    const zip = address.split(' ').findLast((item) => /[0-9]{5}/.test(item));
    const date = parse(data, 'EEEE d MMMM yyyy HH:mm', new Date(), { locale });
    const difference = differenceInCalendarDays(date, new Date());
    if (difference === 0) {
      console.log(`${ricetta} C'è poco tempo...`);
    }
    const goodZip = new RegExp(zipFilter).test(zip); // Cerca in zone comode...
    const goodAddress = new RegExp(addressFilter, 'i').test(address); // Cerca indirizzo...
    // const isGoodPlace = /101[0-9]{2}/.test(zip); //  // Cerca in zone comode...Cerca in zone comode...
    const isGoodDate = difference > 0 && difference <= maxDays;
    const isGoodPlace = goodAddress && goodZip;
    result.appuntamenti.push({
      index: i,
      isGoodPlace,
      isGoodDate,
      date,
      address,
    });
  }
  const printable = Object.assign(result);
  delete printable.images;
  console.log(`Posti disponibili:`, printable);
  const [found] = result.appuntamenti
    .filter(({ isGoodDate, isGoodPlace }) => isGoodDate && isGoodPlace)
    .sort((a, b) => a.date - b.date);
  result.found = found;
  if (!result.found) {
    console.log(`${ricetta} Non ho trovato nulla`);
    await browser.close();
    if (browser && browser.process() != null) {
      browser.process().kill('SIGINT');
    }
    return result;
  }
  console.log(`${ricetta} Ho trovato qualcosa...`);
  console.log(result.found);
  if (result.found.index > 0) {
    console.log(`Provo a selezionare l'elemento ${found.index}`)
    await checkAndClickSelector(`.disponibiliPanel:nth-child(${found.index+1}) span[aria-describedby="Seleziona"] button`);
  }
  await checkAndClickSelector('span[aria-describedby="Avanti"] button');
  if (result.error) {
    return result;
  }

  // PAGE 4 (conferma prenotazione)
  console.log(`${ricetta} page 4`)
  result.images.push(await page.screenshot({ fullPage: true }));
  // Note
  await (async function seeNotes(counter = 0) {
    const [note] = await page.$$('span[aria-describedby="Note"] button');
    if (note) {
      console.log(`${ricetta} Note`);
      await page.click('span[aria-describedby="Note"] button');
      await new Promise((r) => setTimeout(r, 5_000));
    }
    result.images.push(await page.screenshot({ fullPage: true }));
    const [presaVisione] = await page.$$('span[aria-describedby="Conferma presa visione"] button');
    if (presaVisione) {
      console.log(`${ricetta} Presa visione`);
      await page.click('span[aria-describedby="Conferma presa visione"] button');
      await new Promise(r => setTimeout(r, 2_000));
      return;
    }
    return await seeNotes(counter + 1);
  })();

  await checkAndClickSelector('span[aria-describedby="Conferma"] button');


  // await nextPage();
  // await new Promise((r) => setTimeout(r, 10_000));
  // if (result.error) {
  //   result.images.push(await page.screenshot({ fullPage: true }));
  //   await browser.close();
  //   return result;
  // }

  // PAGE 5 (prenotazione confermata)
  console.log(`${ricetta} page 5`)
  console.log(`${ricetta} Preso!`);
  result.images.push(await page.screenshot({ fullPage: true }));
  result.confirmed = result.found;

  await browser.close();
  if (browser && browser.process() != null) {
    browser.process().kill('SIGINT');
  }
  return result;
}

export default reserve;
