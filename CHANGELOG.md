# Changelog

## [0.1.12](https://github.com/laurigates/comfyui-touch-manager/compare/comfyui-touch-manager-v0.1.11...comfyui-touch-manager-v0.1.12) (2026-07-08)


### Features

* **installed:** fold Updates tab into Installed with lazy background update checks ([#36](https://github.com/laurigates/comfyui-touch-manager/issues/36)) ([94a61fd](https://github.com/laurigates/comfyui-touch-manager/commit/94a61fdb61e4e683c209fafc34f6946b779b774a))

## [0.1.11](https://github.com/laurigates/comfyui-touch-manager/compare/comfyui-touch-manager-v0.1.10...comfyui-touch-manager-v0.1.11) (2026-07-06)


### Features

* adopt kit makeLauncher + confirmInShell + ensureStyleOnce; kebab command id ([#32](https://github.com/laurigates/comfyui-touch-manager/issues/32)) ([cb80c8f](https://github.com/laurigates/comfyui-touch-manager/commit/cb80c8fa10fd606f96131cfcba913d96440b7f04))


### Bug Fixes

* refresh lockfile and rebuild dist against published comfy-modal-kit 0.6.0 ([#34](https://github.com/laurigates/comfyui-touch-manager/issues/34)) ([226faeb](https://github.com/laurigates/comfyui-touch-manager/commit/226faebaace7b6ea6aa2395544d689ea001bac8a))

## [0.1.10](https://github.com/laurigates/comfyui-touch-manager/compare/comfyui-touch-manager-v0.1.9...comfyui-touch-manager-v0.1.10) (2026-07-06)


### Features

* **updates:** stay in the same list view after updating a pack ([#30](https://github.com/laurigates/comfyui-touch-manager/issues/30)) ([c912ccc](https://github.com/laurigates/comfyui-touch-manager/commit/c912ccc7ee7b588cc814ac5487e1f0f42ee784e1))

## [0.1.9](https://github.com/laurigates/comfyui-touch-manager/compare/comfyui-touch-manager-v0.1.8...comfyui-touch-manager-v0.1.9) (2026-07-05)


### Features

* **deps:** install requirements.txt/pyproject.toml after git operations ([#27](https://github.com/laurigates/comfyui-touch-manager/issues/27)) ([c6b0ea7](https://github.com/laurigates/comfyui-touch-manager/commit/c6b0ea7c8755feaac59617e5eddfba70ed0d89b1))

## [0.1.8](https://github.com/laurigates/comfyui-touch-manager/compare/comfyui-touch-manager-v0.1.7...comfyui-touch-manager-v0.1.8) (2026-07-04)


### Bug Fixes

* **instrumentation:** surface open-manager failure via copyable notify() ([#25](https://github.com/laurigates/comfyui-touch-manager/issues/25)) ([8dc86a7](https://github.com/laurigates/comfyui-touch-manager/commit/8dc86a7f3c9e0aed8742e315b425e12dc4ba8090))

## [0.1.7](https://github.com/laurigates/comfyui-touch-manager/compare/comfyui-touch-manager-v0.1.6...comfyui-touch-manager-v0.1.7) (2026-06-29)


### Miscellaneous

* finish scaffold — registry assets, screenshot pipeline, renovate/CI sync ([#21](https://github.com/laurigates/comfyui-touch-manager/issues/21)) ([87368c0](https://github.com/laurigates/comfyui-touch-manager/commit/87368c0d0a4359f78f8a35cecb29ca59c38e648a))

## [0.1.6](https://github.com/laurigates/comfyui-touch-manager/compare/comfyui-touch-manager-v0.1.5...comfyui-touch-manager-v0.1.6) (2026-06-28)


### Miscellaneous

* sync uv.lock to 0.1.5 and auto-bump it via release-please ([#18](https://github.com/laurigates/comfyui-touch-manager/issues/18)) ([65bde87](https://github.com/laurigates/comfyui-touch-manager/commit/65bde871cc1615162bb1f24f3995faa95a8c76a2))

## [0.1.5](https://github.com/laurigates/comfyui-touch-manager/compare/comfyui-touch-manager-v0.1.4...comfyui-touch-manager-v0.1.5) (2026-06-27)


### Features

* **notify:** one-tap copy-to-clipboard on error/warning popups ([#16](https://github.com/laurigates/comfyui-touch-manager/issues/16)) ([243ff2c](https://github.com/laurigates/comfyui-touch-manager/commit/243ff2c98c551a023cf27594476bebdca4d7b295))

## [0.1.4](https://github.com/laurigates/comfyui-touch-manager/compare/comfyui-touch-manager-v0.1.3...comfyui-touch-manager-v0.1.4) (2026-06-27)


### Features

* **updates:** in-modal confirms, cached checks, filtering, scroll restore ([#14](https://github.com/laurigates/comfyui-touch-manager/issues/14)) ([5c090fc](https://github.com/laurigates/comfyui-touch-manager/commit/5c090fce3eb427fb7ede4e3b18f65c17db36d145))

## [0.1.3](https://github.com/laurigates/comfyui-touch-manager/compare/comfyui-touch-manager-v0.1.2...comfyui-touch-manager-v0.1.3) (2026-06-26)


### Bug Fixes

* **dist:** commit web/dist so git-based updates carry the built frontend ([#11](https://github.com/laurigates/comfyui-touch-manager/issues/11)) ([01318b0](https://github.com/laurigates/comfyui-touch-manager/commit/01318b0a9468633a42d6e3d1449f10a3292792a3))
* **updates:** skip disabled packs in the updates list ([#13](https://github.com/laurigates/comfyui-touch-manager/issues/13)) ([fbdc196](https://github.com/laurigates/comfyui-touch-manager/commit/fbdc196d9ba7ca28ad787f3b110c17d65f3aab97))

## [0.1.2](https://github.com/laurigates/comfyui-touch-manager/compare/comfyui-touch-manager-v0.1.1...comfyui-touch-manager-v0.1.2) (2026-06-26)


### Features

* add Restart ComfyUI button with relaxed reboot gating ([6697b97](https://github.com/laurigates/comfyui-touch-manager/commit/6697b97b77d57108b795b8372efa28bc3e556240))
* progressive update checking with live progress ([bf6393d](https://github.com/laurigates/comfyui-touch-manager/commit/bf6393dd7e18f934d03d77b71f1a770c0d2d6ecb))
* search and install nodes from the Comfy Registry ([e1820ef](https://github.com/laurigates/comfyui-touch-manager/commit/e1820ef52d95a3de914bede6afae69c5dd42c1f0))
* surface what changed when updating a node pack ([c9a4a77](https://github.com/laurigates/comfyui-touch-manager/commit/c9a4a7747f9295495b2709ab9f018a089e7eb7ba))

## [0.1.1](https://github.com/laurigates/comfyui-touch-manager/compare/comfyui-touch-manager-v0.1.0...comfyui-touch-manager-v0.1.1) (2026-06-25)


### Features

* touch-first node manager (git-ops backend + modal UI) ([f8e9745](https://github.com/laurigates/comfyui-touch-manager/commit/f8e9745f8ea0a9e690ae3161ac8f61c796017f17))


### Bug Fixes

* enable install-from-URL on loopback binds ([28c7d66](https://github.com/laurigates/comfyui-touch-manager/commit/28c7d66c157408616a6c513b3ef99ffae0c85eec))


### Miscellaneous

* **deps-dev:** Bump knip from 5.88.1 to 6.20.0 ([#3](https://github.com/laurigates/comfyui-touch-manager/issues/3)) ([e30678f](https://github.com/laurigates/comfyui-touch-manager/commit/e30678ffa2bc03af7e307c36ebb6e10f768802a7))
* **deps:** Bump actions/checkout from 6 to 7 ([#1](https://github.com/laurigates/comfyui-touch-manager/issues/1)) ([8013ecd](https://github.com/laurigates/comfyui-touch-manager/commit/8013ecd55143f71051fb8208d676b7d7d23a954f))
* **deps:** Bump googleapis/release-please-action from 4 to 5 ([#2](https://github.com/laurigates/comfyui-touch-manager/issues/2)) ([9595d0f](https://github.com/laurigates/comfyui-touch-manager/commit/9595d0fc4c3a41b784826c9fc30b06a7fe3e544d))
* **deps:** sync bun.lock with package.json ([#8](https://github.com/laurigates/comfyui-touch-manager/issues/8)) ([20bf53c](https://github.com/laurigates/comfyui-touch-manager/commit/20bf53c447bc7a4fb19dbb916371e9ff7c1bf596))
* scaffold comfyui-touch-manager backend pack ([f50e286](https://github.com/laurigates/comfyui-touch-manager/commit/f50e286fdd1189ed6198f51279bf512174dacde2))
