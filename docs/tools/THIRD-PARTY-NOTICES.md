# Third-party notices

This directory contains vendored tools used for verification only (not shipped
in the app's production bundle).

## axe.min.js — axe-core v4.13.0

- Source: https://github.com/dequelabs/axe-core
- License: Mozilla Public License 2.0 — https://mozilla.org/MPL/2.0/
- Copyright (c) 2015 - 2026 Deque Systems, Inc.
- The MPL-2.0 copyright header is embedded at the top of `axe.min.js` itself.

## browser-check.mjs / phone-probe.mjs / axe-check.mjs

Dev-only Playwright (playwright-core) probe scripts. `playwright-core` is
installed ad-hoc (`npm install --no-save`), Apache-2.0
(https://github.com/microsoft/playwright). These scripts are not part of the
production app and are excluded from lint.
