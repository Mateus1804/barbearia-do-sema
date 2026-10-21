'use strict';

const { test } = require('node:test');

// O erro de inicialização só é conhecido depois do hook before, na execução do teste.
function createBrowserTest(getLaunchError) {
  return (name, run) => test(name, async context => {
    const error = getLaunchError();
    if (error) {
      if (process.env.REQUIRE_BROWSER_TESTS === '1') throw error;
      context.skip(`Chromium indisponível: ${error.message.split('\n')[0]}`);
      return;
    }
    await run(context);
  });
}

module.exports = { createBrowserTest };
