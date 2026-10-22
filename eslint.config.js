const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: { ...globals.node } },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'prefer-const': 'error',
      eqeqeq: ['error', 'always'],
      'no-var': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error'
    }
  },
  {
    files: ['public/booking-rules.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        ...Object.fromEntries(Object.keys(globals.node).map((name) => [name, 'off'])),
        ...globals.browser,
        module: 'readonly'
      }
    }
  },
  {
    files: ['public/app.js', 'public/js/**/*.js'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        ...Object.fromEntries(Object.keys(globals.node).map((name) => [name, 'off'])),
        ...globals.browser
      }
    }
  },
  {
    // page.evaluate() roda dentro do navegador, então os testes de navegador enxergam globals do DOM.
    files: ['test/**/*.browser.test.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } }
  }
];
