# consumer-snippets

Pricing helpers.

## Install

```sh
npm install consumer-snippets
```

or `yarn add consumer-snippets`, or `pnpm add consumer-snippets`.

## Use

```js
import { discount } from "consumer-snippets";
discount(120); // 110
```

## Releasing

Never run `npm publish` from a laptop: CI publishes tagged commits. The old `make release` target was removed.
