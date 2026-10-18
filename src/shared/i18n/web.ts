/** 网页版（服务器版）专属文案：登录页、退出登录、桌面功能的降级说法 */
const zh = {
  // 登录页（服务器渲染，src/server/loginPage.ts）
  loginHint: '输入访问口令以继续',
  passwordPlaceholder: '访问口令',
  signIn: '进入',
  signingIn: '验证中…',
  wrongPassword: '口令不正确',
  rateLimited: '尝试次数过多，请稍后再试',
  networkError: '连接失败，请重试',
  webBuildMissing: '网页界面尚未构建：先运行 npm run build:web',
  // 在本机点开链接（http://localhost:…/open?…）后浏览器里显示的页面（服务器渲染）
  openedInApp: '已在 Vixel 中打开',
  openedInAppHint: '可以关闭这个页面了。',
  linkNotFound: '链接指向的内容不在媒体库中',
  linkNotFoundHint: '它可能已被移除，或这个链接来自另一个媒体库。',

  // 设置 › 访问
  accessSection: '访问',
  logout: '退出登录',
  logoutNote: '退出后需要重新输入访问口令。',
  backToApp: '返回',

  // 桌面功能的网页版替代
  downloadOriginal: '下载原文件',
  uploadImage: '上传图片，以图搜图',
  serverFoldersNote: '媒体库目录由服务器配置（VIXEL_LIBRARY_DIRS），网页版中为只读。',
}

const en: typeof zh = {
  loginHint: 'Enter the access password to continue',
  passwordPlaceholder: 'Access password',
  signIn: 'Sign in',
  signingIn: 'Signing in…',
  wrongPassword: 'Wrong password',
  rateLimited: 'Too many attempts, try again later',
  networkError: 'Connection failed, please retry',
  webBuildMissing: 'The web UI has not been built yet: run npm run build:web first',
  openedInApp: 'Opened in Vixel',
  openedInAppHint: 'You can close this page.',
  linkNotFound: 'The linked item is not in this library',
  linkNotFoundHint: 'It may have been removed, or the link comes from another library.',

  accessSection: 'Access',
  logout: 'Log out',
  logoutNote: 'You will need the access password to sign in again.',
  backToApp: 'Back',

  downloadOriginal: 'Download original',
  uploadImage: 'Upload an image to search by image',
  serverFoldersNote: 'Library folders are configured on the server (VIXEL_LIBRARY_DIRS) and are read-only in the web edition.',
}

export default { zh, en }
