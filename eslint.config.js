// @ts-check

const eslint = require('@eslint/js')
const typescriptEslint = require('typescript-eslint')
const typescriptParser = require('@typescript-eslint/parser')

const config = typescriptEslint.config(
  eslint.configs.recommended,
  ...typescriptEslint.configs.recommendedTypeChecked,

  {
    ignores: ['spec/tmp/**/*', 'test-app/src/types/*', '.yarn/**/*', '.yarnrc.yml'],
  },

  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: typescriptParser,
      parserOptions: { project: './tsconfig.json' },
    },
  },
)
module.exports = config
