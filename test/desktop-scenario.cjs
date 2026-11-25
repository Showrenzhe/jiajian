'use strict';
require('./desktop-failure-hook.cjs');
require(require('node:path').join(__dirname, process.env.JIAJIAN_DESKTOP_SCENARIO));
