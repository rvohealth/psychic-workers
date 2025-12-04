// @ts-check

import eslint from '@eslint/js'
import typescriptEslint from 'typescript-eslint'
import typescriptParser from '@typescript-eslint/parser'

const config = typescriptEslint.config(
  eslint.configs.recommended,
  typescriptEslint.configs.recommendedTypeChecked,

  {
    ignores: ['docs/**/*', 'spec/tmp/**/*', 'test-app/src/types/**/*', '.npmrc', 'dist/**/*'],
  },

  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: typescriptParser,
      parserOptions: { project: './tsconfig.json' },
    },
  },
)

export default config
