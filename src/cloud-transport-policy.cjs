'use strict';
const allowedLocalTest = () =>
  process.env.JIAJIAN_TEST_LOOPBACK === '1' && (!process.versions.electron || !require('electron').app?.isPackaged);
module.exports = { allowedLocalTest };
