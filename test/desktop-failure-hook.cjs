'use strict';

const { app, BrowserWindow } = require('electron');
const { writeFile } = require('node:fs/promises');
const exit = app.exit.bind(app);
let lastWindowImage;

app.on('browser-window-created', (_event, win) => {
  // Some scenarios destroy their window in a finally block before reporting
  // the assertion. Keep one local fallback for that case.
  win.once('ready-to-show', () => {
    win.webContents
      .capturePage()
      .then((picture) => {
        if (!picture.isEmpty()) lastWindowImage = picture.toPNG();
      })
      .catch(() => {});
  });
});

// Existing scenarios exit explicitly after their assertions. Capture only the test
// window, so logs can be collected even when Windows has other apps in front.
app.exit = (code = 0) => {
  if (!code) return exit(code);
  const guard = setTimeout(() => exit(code), 3000);
  const win = BrowserWindow.getAllWindows().find((window) => !window.isDestroyed());
  Promise.resolve()
    .then(async () => {
      const picture = win && (await win.webContents.capturePage().catch(() => null));
      const image = picture && !picture.isEmpty() ? picture.toPNG() : lastWindowImage;
      if (image) await writeFile(process.env.JIAJIAN_TEST_SCREENSHOT, image);
    })
    .catch((error) => console.error('截图失败', error.message))
    .finally(() => {
      clearTimeout(guard);
      exit(code);
    });
};
