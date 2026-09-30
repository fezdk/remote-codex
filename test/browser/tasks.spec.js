import {test,expect} from '@playwright/test';
async function login(page) {
  await page.goto('/#session=session-one');await page.locator('#access-key').fill('browser-test-access-key-123456789');await page.locator('#login-form button[type=submit]').click();
  await expect(page.locator('#attach-image')).toBeVisible();await expect(page.locator('#attach-image')).toBeEnabled();
  if(await page.locator('#interrupt').isVisible()){await page.locator('#interrupt').click();await expect(page.locator('#interrupt')).toBeHidden();}
}
async function start(page){await page.locator('#message').fill('task fixture');await page.locator('#send').click();await expect(page.locator('#interrupt')).toBeVisible();await expect(page.locator('#message')).toHaveValue('');}
async function show(page){if(!await page.locator('#changes-panel').isVisible())await page.locator('#toggle-changes').click();await page.locator('#tasks-tab').click();}
test('native task progress updates live, survives reload and session switching, and keeps earlier/unfinished plans explicit',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await login(page);await start(page);await show(page);
  await expect(page.locator('.task-step')).toHaveCount(3);await expect(page.locator('#changes-summary')).toHaveText('1 af 3 trin færdige');
  await expect(page.locator('.task-state')).toHaveText(['Færdig','I gang','Afventer']);await expect(page.locator('.task-text').last()).toContainText('<script>literal</script>');await expect(page.locator('.task-list script')).toHaveCount(0);
  await page.locator('#message').fill('Keep this draft');await page.locator('#tasks-tab').press('ArrowLeft');await expect(page.locator('#git-tab')).toBeFocused();await page.locator('#git-tab').press('Home');await expect(page.locator('#codex-tab')).toBeFocused();await page.locator('#codex-tab').press('End');await expect(page.locator('#tasks-tab')).toBeFocused();await expect(page.locator('#message')).toHaveValue('Keep this draft');
  await page.reload();await show(page);await expect(page.locator('.task-step')).toHaveCount(3);
  await page.getByRole('button',{name:/Mit andet projekt/}).click();await expect(page.locator('#changes-summary')).toContainText('Ingen opgaveliste');await expect(page.locator('.task-step')).toHaveCount(0);
  await page.getByRole('button',{name:/Byg et browser-UI/}).click();await expect(page.locator('.task-step')).toHaveCount(3);
  await page.locator('#message').fill('task fixture finish');await page.locator('#steer').click();await expect(page.locator('#changes-summary')).toHaveText('3 af 3 trin færdige');await expect(page.locator('#change-detail')).toContainText('Svaret er afsluttet');
  await page.locator('#workspace [data-language-select]').selectOption('en');await expect(page.locator('#tasks-tab')).toHaveText('Tasks');await expect(page.locator('.task-state')).toHaveText(['Completed','Completed','Completed']);
  await page.screenshot({path:'test-results/tasks-desktop.png',animations:'disabled'});
  await page.locator('#message').fill('long');await page.locator('#send').click();await expect(page.locator('#change-detail')).toContainText('Plan from an earlier task');await page.locator('#interrupt').click();
  await start(page);await page.locator('#interrupt').click();await expect(page.locator('#change-detail')).toContainText('The task was interrupted');await expect(page.locator('#changes-summary')).toHaveText('1 of 3 steps completed');
  expect(errors).toEqual([]);
});
test('late plan reads cannot replace newer events, another session or a logged-out view',async({page})=>{
  await login(page);await start(page);await show(page);await expect(page.locator('.task-step')).toHaveCount(3);
  let release;const gate=new Promise(resolve=>release=resolve);await page.route('**/session-one/plan',async route=>{const response=await route.fetch();await gate;await route.fulfill({response});});
  const pending=page.waitForRequest('**/session-one/plan');await page.locator('#refresh-changes').click();await pending;
  await page.locator('#message').fill('task fixture finish');await page.locator('#steer').click();await expect(page.locator('#changes-summary')).toHaveText('3 af 3 trin færdige');release();await page.unrouteAll({behavior:'wait'});await expect(page.locator('#changes-summary')).toHaveText('3 af 3 trin færdige');
  let releaseSecond;const second=new Promise(resolve=>releaseSecond=resolve);await page.route('**/session-one/plan',async route=>{const response=await route.fetch();await second;await route.fulfill({response});});
  const reading=page.waitForRequest('**/session-one/plan');await page.locator('#refresh-changes').click();await reading;
  await page.getByRole('button',{name:/Mit andet projekt/}).click();await expect(page.locator('.task-step')).toHaveCount(0);releaseSecond();await page.unrouteAll({behavior:'wait'});await expect(page.locator('.task-step')).toHaveCount(0);
  await page.locator('#logout').click();await expect(page.locator('#login')).toBeVisible();await expect(page.locator('.task-step')).toHaveCount(0);
});
test('tasks fit mobile in both themes; unavailable reads and missing plans stay explicit',async({page})=>{
  await page.setViewportSize({width:390,height:844});await login(page);await start(page);await show(page);await expect(page.locator('.task-step')).toHaveCount(3);
  for(let i=0;i<2;i++){expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.locator('#workspace [data-theme-toggle]').click();}
  await page.screenshot({path:'test-results/tasks-mobile.png',animations:'disabled'});
  await page.setViewportSize({width:320,height:600});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.route('**/session-one/plan',route=>route.fulfill({status:503,json:{errorKey:'error.disconnected'}}));await page.locator('#refresh-changes').click();await expect(page.locator('#changes-summary')).toHaveClass(/error/);await expect(page.locator('.task-step')).toHaveCount(3);
  await page.unroute('**/session-one/plan');await page.route('**/session-one/plan',route=>route.fulfill({json:{plan:null}}));await page.locator('#refresh-changes').click();await expect(page.locator('.task-step')).toHaveCount(0);await expect(page.locator('#changes-summary')).toContainText('Ingen opgaveliste');
  await page.locator('#close-changes').press('Escape');await expect(page.locator('#changes-panel')).toBeHidden();await page.locator('#interrupt').click();
});
