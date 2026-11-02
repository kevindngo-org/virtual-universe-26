import { test, expect } from '@playwright/test';

const tabs = [
  { id: 'tab-stack', title: 'monas-cafe \u2014 gh stack', firstLine: 'gh stack init fix/price-parser', lastLine: 'Two small pull requests, reviewed in order.' },
  { id: 'tab-issue', title: 'monas-cafe \u2014 gh issue comment --attach', firstLine: 'npx playwright test', lastLine: 'Screenshot attached, alt text and all.' },
  { id: 'tab-pr', title: 'monas-cafe \u2014 gh pr create --attach', firstLine: 'gh pr create', lastLine: 'without leaving the terminal.' },
];

const guides = [
  { name: 'Skills', user: 'Can you turn an issue into a suggested fix?', copilot: 'Use /issue-to-pr to propose a fix and open a draft PR for human review.', steps: ['Read the issue and the code it mentions', 'Made the smallest fix and ran the tests', 'Opened a draft PR for your review'] },
  { name: 'Tools and connectors', user: 'Check the current Node.js documentation.', copilot: 'Use Context7 to ground the fix in current documentation and inspect its source links.', steps: ['Found a documentation agent with /agentfinder', 'Added Context7 through Customize', 'Looked up current Node.js docs with sources'] },
  { name: 'Security review', user: 'Review the last PR created by the skill.', copilot: 'Run /security-review on the fix in that PR, not unrelated local changes.', steps: ['Reviewed the changed lines in the PR', 'Reported only high-confidence findings', 'Added the review step to the skill'] },
  { name: 'Automate', user: 'Turn this skill into an automation.', copilot: 'Select your fork, choose /issue-to-pr, and start with a Manual trigger.', steps: ['Opened Automations and clicked New Automation', 'Selected your fork as the project', 'Ran it manually; schedule it later'] },
];

test.beforeEach(async ({ page }) => {
  // Keep the smoke tests offline: only the local docs server may be reached.
  await page.route(url => !['127.0.0.1', 'localhost'].includes(url.hostname), route => route.abort());
});

async function expectSelectedTab(page, index) {
  for (const [i, tab] of tabs.entries()) {
    const locator = page.locator(`#${tab.id}`);
    await expect(locator).toHaveAttribute('aria-selected', String(i === index));
    await expect(locator).toHaveAttribute('tabindex', i === index ? '0' : '-1');
  }
  await expect(page.locator(`#${tabs[index].id}`)).toBeFocused();
  await expect(page.locator('#terminal-title')).toHaveText(tabs[index].title);
  await expect(page.locator('#terminal-screen')).toHaveAttribute('aria-labelledby', tabs[index].id);
}

test('arrow keys, Home, and End move between CLI tabs', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.locator('#tab-stack').focus();

  await page.keyboard.press('ArrowRight');
  await expectSelectedTab(page, 1);
  await page.keyboard.press('ArrowRight');
  await expectSelectedTab(page, 2);
  await page.keyboard.press('ArrowRight');
  await expectSelectedTab(page, 0);
  await page.keyboard.press('ArrowLeft');
  await expectSelectedTab(page, 2);
  await page.keyboard.press('ArrowLeft');
  await expectSelectedTab(page, 1);
  await page.keyboard.press('Home');
  await expectSelectedTab(page, 0);
  await page.keyboard.press('End');
  await expectSelectedTab(page, 2);
  await expect(page.locator('#terminal-screen')).toContainText(tabs[2].lastLine);
});

test('Pause shows the full example and Play resumes the animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.clock.install();
  await page.goto('/');
  const screen = page.locator('#terminal-screen');
  const pause = page.locator('#pause');

  await expect(pause).toBeVisible();
  await expect(pause).toHaveText('Pause');
  await page.clock.runFor(350);
  await expect(screen).not.toContainText(tabs[0].lastLine);

  await pause.click();
  await expect(pause).toHaveText('Play');
  await expect(screen).toContainText(tabs[0].firstLine);
  await expect(screen).toContainText(tabs[0].lastLine);

  // While paused, nothing retypes the example or advances to the next tab.
  await page.clock.runFor(20_000);
  await expect(screen).toContainText(tabs[0].lastLine);
  await expect(page.locator('#tab-stack')).toHaveAttribute('aria-selected', 'true');

  await pause.click();
  await expect(pause).toHaveText('Pause');
  await expect(screen).not.toContainText(tabs[0].lastLine);
  const restarted = (await screen.textContent()).length;
  await page.clock.runFor(350);
  expect((await screen.textContent()).length).toBeGreaterThan(restarted);
  await page.clock.runFor(4_500);
  await expect(screen).toContainText(tabs[0].lastLine);
  await expect(page.locator('#tab-stack')).toHaveAttribute('aria-selected', 'true');

  // Once typing finishes, the animation advances to the next example.
  await page.clock.runFor(5_000);
  await expect(page.locator('#tab-issue')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#terminal-title')).toHaveText(tabs[1].title);
});

test('reduced motion renders the full example immediately and hides Pause', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install();
  await page.goto('/');
  const screen = page.locator('#terminal-screen');

  await expect(page.locator('#pause')).toBeHidden();
  await expect(screen).toContainText(tabs[0].firstLine);
  await expect(screen).toContainText(tabs[0].lastLine);

  await page.locator('#tab-issue').click();
  await expect(page.locator('#terminal-title')).toHaveText(tabs[1].title);
  await expect(screen).toContainText(tabs[1].lastLine);

  await page.locator('#replay').click();
  await expect(screen).toContainText(tabs[1].lastLine);
  await expect(page.locator('#pause')).toBeHidden();
});

test('opening each guide updates the illustrative chat and step list', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const steps = page.locator('#copilot-steps');
  await expect(steps).toBeHidden();

  for (const guide of guides) {
    await page.locator('.guides summary', { hasText: guide.name }).click();
    await expect(page.locator('.guides details', { hasText: guide.name })).toHaveAttribute('open', '');
    await expect(page.locator('#user-message')).toHaveText(guide.user);
    await expect(page.locator('#copilot-message')).toHaveText(guide.copilot);
    await expect(steps).toBeVisible();
    await expect(steps.locator('li')).toHaveText(guide.steps);
  }
});
