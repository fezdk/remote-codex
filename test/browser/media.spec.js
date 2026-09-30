import { test, expect } from '@playwright/test';
import { imageBytes, imageData } from '../image-fixture.js';
const file = (name = 'synthetic-preview.png') => ({name,mimeType:'image/png',buffer:imageBytes});
async function login(page) {
  await page.goto('/#session=session-one');await page.locator('#access-key').fill('browser-test-access-key-123456789');
  await page.locator('#login-form button[type=submit]').click();await expect(page.locator('#attach-image')).toBeVisible();await expect(page.locator('#attach-image')).toBeEnabled();
  if (await page.locator('#interrupt').isVisible()) {await page.locator('#interrupt').click();await expect(page.locator('#interrupt')).toBeHidden();}
}
async function attach(page,name) {
  await page.locator('#image-files').setInputFiles(file(name));
  await expect(page.locator('#attachments')).not.toContainText('Uploader');
  await expect(page.locator('#attachments img')).toHaveCount(1);
  await expect(page.locator('#send')).toBeEnabled();
}
const loaded = async locator => {await expect.poll(()=>locator.evaluate(img=>img.complete && img.naturalWidth)).toBeGreaterThan(0);};

test('file picker sends image-only input, renders history, opens a full image and downloads identical bytes',async({page})=>{
  await login(page);await attach(page);
  const sent=page.waitForRequest(req=>req.url().endsWith('/message')&&req.method()==='POST');
  await page.locator('#send').click();const body=(await sent).postDataJSON();expect(body.text).toBe('');expect(body.images).toHaveLength(1);
  await expect(page.locator('#attachments')).toBeHidden();await expect(page.locator('#interrupt')).toBeHidden();
  const image=page.locator('#messages .message.user .image-gallery img').last();await loaded(image);
  await expect(page.locator('#messages .message.user').last().locator('.message-body')).toHaveCount(0);
  const url=await image.getAttribute('src');await image.click();await expect(page.locator('#image-dialog')).toBeVisible();await loaded(page.locator('#image-view'));
  const download=page.waitForEvent('download');await page.locator('#image-download').click();expect((await download).suggestedFilename()).toBe('image.png');
  const bytes=await page.request.get(url+'?download=1');expect(await bytes.body()).toEqual(imageBytes);
  await page.keyboard.press('Escape');await expect(page.locator('#image-dialog')).toBeHidden();
  await page.reload();await loaded(page.locator('#messages .message.user .image-gallery img').last());
});

test('images survive queue editing, ArrowUp and conversion to Steer without a duplicate bubble',async({page})=>{
  await login(page);await page.locator('#message').fill('long');await page.locator('#send').click();await expect(page.locator('#interrupt')).toBeVisible();await expect(page.locator('#message')).toHaveValue('');
  await attach(page);await page.locator('#message').fill('Review this synthetic screenshot');await page.locator('#send').click();
  await expect(page.locator('#queue-list .image-gallery img')).toHaveCount(1);await expect(page.locator('#attachments')).toBeHidden();
  let finishEdit;const editGate=new Promise(resolve=>{finishEdit=resolve;});
  await page.route('**/queue/*/delete',async route=>{const response=await route.fetch();await editGate;await route.fulfill({response});});
  try { await page.locator('#message').press('ArrowUp');await expect(page.locator('#attach-image')).toBeDisabled(); }
  finally {finishEdit();}
  await expect(page.locator('#edit-mode')).toBeVisible();await expect(page.locator('#attachments img')).toHaveCount(1);
  await page.unroute('**/queue/*/delete');
  await expect(page.locator('#message')).toHaveValue('Review this synthetic screenshot');
  await page.locator('#message').press('Enter');await expect(page.locator('#queue-list .image-gallery img')).toHaveCount(1);
  const sent=page.waitForRequest(req=>req.url().endsWith('/message')&&req.method()==='POST');await page.getByRole('button',{name:'Send som steer',exact:true}).click();
  expect((await sent).postDataJSON().images).toHaveLength(1);
  await expect(page.locator('#queue-list')).toBeEmpty();await expect(page.locator('.pending-steer')).toHaveCount(0);
  const message=page.locator('#messages .message.user').filter({hasText:'Review this synthetic screenshot'});await expect(message).toHaveCount(1);await loaded(message.locator('img'));
  await page.locator('#interrupt').click();await expect(page.locator('#interrupt')).toBeHidden();
  await page.locator('#message').press('ArrowUp');await expect(page.locator('#attachments img')).toHaveCount(1);await expect(page.locator('#message')).toHaveValue('Review this synthetic screenshot');
});

test('delayed uploads remain with their original session and a late send acknowledgement preserves new attachments',async({page})=>{
  await login(page);
  let release;const gate=new Promise(resolve=>{release=resolve;});
  await page.route('**/session-one/images',async route=>{const response=await route.fetch();await gate;await route.fulfill({response});});
  try {
    await page.locator('#image-files').setInputFiles(file('first.png'));await expect(page.locator('#attachments')).toContainText('Uploader');await expect(page.locator('#send')).toBeDisabled();
    await page.getByRole('button',{name:/Mit andet projekt/}).click();await expect(page.locator('#attachments')).toBeHidden();
  } finally {release();}
  await page.getByRole('button',{name:/Byg et browser-UI/}).click();await expect(page.locator('#attachments')).toContainText('first.png');await expect(page.locator('#send')).toBeEnabled();
  await page.unroute('**/session-one/images');
  let finish;const ack=new Promise(resolve=>{finish=resolve;});let received;
  await page.route('**/session-one/message',async route=>{received=route.request().postDataJSON();const response=await route.fetch();await ack;await route.fulfill({response});});
  try {
    await page.locator('#message').fill('First attachment');await page.locator('#send').click();await expect.poll(()=>received?.images.length).toBe(1);
    await page.locator('#image-files').setInputFiles(file('next.png'));await expect(page.locator('#attachments')).toContainText('next.png');
    await page.locator('#message').fill('Next draft');
  } finally {finish();}
  await expect(page.locator('#attachments img')).toHaveCount(1);await expect(page.locator('#attachments')).toContainText('next.png');await expect(page.locator('#message')).toHaveValue('Next draft');
});

test('generated and structured tool images are visible live and after reload',async({page})=>{
  await login(page);await page.locator('#message').fill('image fixture');await page.locator('#send').click();
  const result=page.locator('#messages .image-message').last();await loaded(result.locator('.image-gallery img'));
  await page.reload();await loaded(page.locator('#messages .image-message').last().locator('.image-gallery img'));
  const rendered=page.locator('#messages .image-message').last();
  await rendered.locator('summary').click();await expect(rendered).toContainText('Synthetic preview details');
  const imageRequests=[];page.on('request',request=>{if (/\/images\/[a-f0-9]+$/.test(request.url())) imageRequests.push(request.url());});
  await page.locator('#message').fill('long');await page.locator('#send').click();await expect(page.locator('#interrupt')).toBeVisible();await expect(page.locator('#message')).toHaveValue('');
  await page.locator('#message').fill('A draft while images remain visible');
  await page.locator('#interrupt').click();await expect(page.locator('#interrupt')).toBeHidden();
  expect(imageRequests).toEqual([]);
  await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:'test-results/image-results-desktop.png'});
  await page.locator('#workspace [data-language-select]').selectOption('en');
  await expect(page.locator('#messages .image-message').last()).toContainText('Image from Codex');
});

test('paste and drop support compact mobile previews, removal, validation and translated controls',async({page})=>{
  await page.setViewportSize({width:390,height:844});await login(page);
  await page.locator('#message').evaluate((input,data)=>{
    const bytes=Uint8Array.from(atob(data.split(',')[1]),c=>c.charCodeAt(0));const transfer=new DataTransfer();transfer.items.add(new File([bytes],'pasted.png',{type:'image/png'}));
    // Firefox discards clipboardData passed to the synthetic event constructor.
    const event=new Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(event,'clipboardData',{value:transfer});input.dispatchEvent(event);
  },imageData);
  await expect(page.locator('#attachments')).toContainText('pasted.png');await expect(page.locator('#send')).toBeEnabled();
  await page.locator('.conversation').evaluate((area,data)=>{
    const bytes=Uint8Array.from(atob(data.split(',')[1]),c=>c.charCodeAt(0));const transfer=new DataTransfer();transfer.items.add(new File([bytes],'dropped.png',{type:'image/png'}));
    const event=new Event('drop',{bubbles:true,cancelable:true});Object.defineProperty(event,'dataTransfer',{value:transfer});area.dispatchEvent(event);
  },imageData);
  await expect(page.locator('#attachments img')).toHaveCount(2);await expect(page.locator('#send')).toBeEnabled();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/image-attachments-mobile.png'});
  await page.locator('#workspace [data-language-select]').selectOption('en');await expect(page.locator('#attach-image')).toHaveAttribute('aria-label','Attach images');
  await page.getByRole('button',{name:'Remove pasted.png',exact:true}).click();await expect(page.locator('#attachments img')).toHaveCount(1);
  await page.locator('#image-files').setInputFiles({name:'bad.svg',mimeType:'image/svg+xml',buffer:Buffer.from('<svg/>')});await expect(page.locator('#notice')).toContainText('Choose a valid');await expect(page.locator('#attachments img')).toHaveCount(1);
  await page.locator('#image-files').setInputFiles([file('1.png'),file('2.png'),file('3.png'),file('4.png')]);await expect(page.locator('#notice')).toContainText('up to four');await expect(page.locator('#attachments img')).toHaveCount(1);
  await page.getByRole('button',{name:'Remove dropped.png',exact:true}).click();await expect(page.locator('#attachments')).toBeHidden();await expect(page.locator('#send')).toBeDisabled();
});

test('failed sends retain images and logout invalidates uploads in flight',async({page})=>{
  await login(page);await attach(page);
  await page.route('**/session-one/message',route=>route.fulfill({status:503,json:{error:'Synthetic send failure'}}));
  await page.locator('#send').click();await expect(page.locator('#notice')).toContainText('Synthetic send failure');await expect(page.locator('#attachments img')).toHaveCount(1);await expect(page.locator('#send')).toBeEnabled();
  let release;const gate=new Promise(resolve=>{release=resolve;});
  await page.route('**/session-one/images',async route=>{const response=await route.fetch();await gate;await route.fulfill({response});});
  try {
    await page.locator('#image-files').setInputFiles(file('late.png'));await expect(page.locator('#attachments')).toContainText('Uploader');
    await page.locator('#logout').click();await expect(page.locator('#login')).toBeVisible();
  } finally {release();}
  await expect(page.locator('#attachments')).toBeEmpty();await expect(page.locator('#image-dialog')).toBeHidden();
});
