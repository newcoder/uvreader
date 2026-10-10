## 改了什么


## 为什么这样改


## 验证

- [ ] `npm test`
- [ ] `npm run test:shim` / `npm run test:desktop`（涉及宿主兼容层或桌面壳时）
- [ ] `npm run check:i18n`
- [ ] `npx eslint packages/reader/src packages/host-shim apps/desktop/src apps/desktop/test apps/desktop/scripts apps/desktop/build.mjs tests scripts --max-warnings=0`
- [ ] 涉及界面/打包时：`npm run desktop:build` 与 `npm run desktop:smoke`（必要时 `npm run desktop:e2e`）
