import {test, expect} from '@playwright/test';

test('video cutaways use a video element and initial play is called in the click gesture before metadata', async ({page}) => {
  // Delay metadata. The old implementation called play only in loadedmetadata.
  await page.route('**/*.webm', () => { /* Keep metadata pending until the test ends. */ });
  await page.addInitScript(() => {
    (window as any).playCalls = [];
    HTMLMediaElement.prototype.play = function () {
      (window as any).playCalls.push({tag:this.tagName,active:navigator.userActivation.isActive});
      return Promise.resolve();
    };
  });
  await page.goto('/e2e/fixtures/preview.html');
  await expect(page.locator('video.live-broll')).toHaveCount(1);
  await expect(page.locator('img.live-broll')).toHaveCount(0);
  await page.getByRole('button',{name:'Play the edit'}).click();
  const calls = await page.evaluate(() => (window as any).playCalls);
  expect(calls.some((c:any)=>c.tag === 'VIDEO' && c.active)).toBe(true);
});
