const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: { ...globals.node } },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'prefer-const': 'warn',
      eqeqeq: ['warn', 'always'],
      'no-var': 'warn'
    }
  },
  {
    files: ['public/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser, BookingRules: 'readonly', module: 'readonly' } }
  },
  {
    // page.evaluate() roda dentro do navegador, então os testes de navegador enxergam globals do DOM.
    files: ['test/**/*.browser.test.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } }
  }
];
