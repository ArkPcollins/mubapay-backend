const { join } = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // Forces Chrome to install inside your project workspace so Render can't delete it
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
