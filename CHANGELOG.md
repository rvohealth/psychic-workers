## 2.1.0

- add custom AST type builder to create custom types file for psychic workers, rather than piggy-backing off of psychic type builder, since that functionality is soon to be removed. This creates breaking changes at the type layer, so an automated script was added to refactor deprecated code to match the new type import location.

## 2.0.2

fix background with delay with debounce

## 2.0.1

bump glob to close dependabot alert

## 2.0.0

- namespace exports
- support Dream and Psychic 2.0

## 1.4.0

- throw an error if attempting to background an entire Dream model

## 1.3.0

- update for Psychic 1.11.1 and modern Dream

## 1.2.0

- update for Dream 1.4.0
