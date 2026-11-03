// macOS 原生外壳：自带窗口（WKWebView）+ Dock 图标 + 标准菜单，后台拉起内置 Node 代理。
// 代理与 Windows/Linux 共用 server/desktop.mjs（WB_SHELL=native 时只起服务、不开浏览器窗口）。
// 退出 App 时结束代理；App 异常退出时代理读到 stdin EOF 也会自己退出。
import Cocoa
import WebKit

let PORT = 18787
let BASE = URL(string: "http://127.0.0.1:\(PORT)/")!
let NAME = (Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String) ?? "Jira工作台"
let LOG_HINT = "~/Library/Application Support/JiraWorkbench/run.log"

/** 本机代理是否已在运行（同一个 App 的实例） */
func ping() -> Bool {
  var req = URLRequest(url: BASE.appendingPathComponent("api/ping"))
  req.timeoutInterval = 1
  let sem = DispatchSemaphore(value: 0)
  var ok = false
  URLSession.shared.dataTask(with: req) { data, _, _ in
    if let d = data, let s = String(data: d, encoding: .utf8), s.contains("jira-workbench") { ok = true }
    sem.signal()
  }.resume()
  _ = sem.wait(timeout: .now() + 1.5)
  return ok
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate, WKNavigationDelegate, WKDownloadDelegate {
  var window: NSWindow!
  var web: WKWebView!
  var server: Process?
  let stdinPipe = Pipe() // 持有写端：App 退出后代理读到 EOF
  var downloads: [ObjectIdentifier: URL] = [:]

  func applicationDidFinishLaunching(_ notification: Notification) {
    buildMenu()
    makeWindow()
    web.loadHTMLString(Self.page("正在启动…", ""), baseURL: nil)
    DispatchQueue.global(qos: .userInitiated).async {
      let ok = self.ensureServer()
      DispatchQueue.main.async {
        if ok {
          self.web.load(URLRequest(url: BASE))
        } else {
          self.fatal("本地服务没有启动成功（端口 \(PORT) 可能被其他程序占用）。\n日志：\(LOG_HINT)")
        }
      }
    }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

  func applicationWillTerminate(_ notification: Notification) {
    guard let p = server, p.isRunning else { return }
    p.terminate() // SIGTERM：代理会先把登录状态落盘
    let deadline = Date().addingTimeInterval(2)
    while p.isRunning && Date() < deadline { usleep(50_000) }
  }

  // ---------- 代理 ----------

  func ensureServer() -> Bool {
    if ping() { return true }
    let res = Bundle.main.resourceURL!
    let p = Process()
    p.executableURL = res.appendingPathComponent("node")
    p.arguments = [res.appendingPathComponent("app/server/desktop.mjs").path]
    var env = ProcessInfo.processInfo.environment
    env["WB_SHELL"] = "native"
    p.environment = env
    p.standardInput = stdinPipe
    p.standardOutput = FileHandle.nullDevice // 代理自己写 run.log
    p.standardError = FileHandle.nullDevice
    do { try p.run() } catch { return false }
    server = p
    for _ in 0..<80 { // 最多等 20 秒
      if !p.isRunning { return false }
      if ping() { return true }
      usleep(250_000)
    }
    return false
  }

  func fatal(_ msg: String) {
    let a = NSAlert()
    a.messageText = "\(NAME) 启动失败"
    a.informativeText = msg
    a.alertStyle = .critical
    a.runModal()
    NSApp.terminate(nil)
  }

  // ---------- 窗口 ----------

  func makeWindow() {
    let cfg = WKWebViewConfiguration()
    cfg.websiteDataStore = .default() // 持久化：登录 cookie、localStorage（筛选、最近查看等）
    cfg.preferences.javaScriptCanOpenWindowsAutomatically = false
    web = WKWebView(frame: .zero, configuration: cfg)
    web.uiDelegate = self
    web.navigationDelegate = self
    web.allowsBackForwardNavigationGestures = true
    if #available(macOS 13.3, *) { web.isInspectable = true }

    let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    let size = NSSize(width: min(1440, screen.width * 0.92), height: min(900, screen.height * 0.92))
    window = NSWindow(
      contentRect: NSRect(origin: .zero, size: size),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered, defer: false)
    window.title = NAME
    window.minSize = NSSize(width: 900, height: 600)
    window.tabbingMode = .disallowed
    window.contentView = web
    window.center()
    window.setFrameAutosaveName("main") // 记住上次的位置和大小
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  static func page(_ title: String, _ extra: String) -> String {
    """
    <html><body style="margin:0;height:100vh;display:grid;place-items:center;background:#f4f0e6;color:#1d2733;
    font:15px 'PingFang SC',sans-serif"><div style="text-align:center"><div style="font:700 22px 'Songti SC',serif;
    letter-spacing:.06em;margin-bottom:10px">研发工作台</div><div style="color:#8a8f96">\(title)</div>\(extra)</div></body></html>
    """
  }

  // ---------- 菜单（没有「编辑」菜单时 ⌘C/⌘V 在网页里不可用） ----------

  func buildMenu() {
    let main = NSMenu()
    func sub(_ title: String, _ items: [NSMenuItem]) -> NSMenu {
      let m = NSMenu(title: title)
      items.forEach(m.addItem)
      let host = NSMenuItem()
      host.submenu = m
      main.addItem(host)
      return m
    }
    func item(_ t: String, _ a: Selector?, _ k: String, _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
      let i = NSMenuItem(title: t, action: a, keyEquivalent: k)
      i.keyEquivalentModifierMask = mods
      return i
    }
    _ = sub(NAME, [
      item("关于 \(NAME)", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), ""),
      .separator(),
      item("隐藏 \(NAME)", #selector(NSApplication.hide(_:)), "h"),
      item("隐藏其他", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
      item("全部显示", #selector(NSApplication.unhideAllApplications(_:)), ""),
      .separator(),
      item("退出 \(NAME)", #selector(NSApplication.terminate(_:)), "q"),
    ])
    _ = sub("编辑", [
      item("撤销", Selector(("undo:")), "z"),
      item("重做", Selector(("redo:")), "z", [.command, .shift]),
      .separator(),
      item("剪切", #selector(NSText.cut(_:)), "x"),
      item("拷贝", #selector(NSText.copy(_:)), "c"),
      item("粘贴", #selector(NSText.paste(_:)), "v"),
      item("全选", #selector(NSText.selectAll(_:)), "a"),
    ])
    let view = [
      item("重新载入", #selector(reloadPage), "r"),
      .separator(),
      item("实际大小", #selector(zoomReset), "0"),
      item("放大", #selector(zoomIn), "="),
      item("缩小", #selector(zoomOut), "-"),
    ]
    view.forEach { $0.target = self }
    _ = sub("显示", view)
    let win = sub("窗口", [
      item("最小化", #selector(NSWindow.performMiniaturize(_:)), "m"),
      item("缩放", #selector(NSWindow.performZoom(_:)), ""),
      .separator(),
      item("关闭窗口", #selector(NSWindow.performClose(_:)), "w"),
    ])
    NSApp.mainMenu = main
    NSApp.windowsMenu = win
  }

  @objc func reloadPage() {
    if web.url?.host == BASE.host { web.reload() } else { web.load(URLRequest(url: BASE)) }
  }
  @objc func zoomReset() { web.pageZoom = 1 }
  @objc func zoomIn() { web.pageZoom = min(web.pageZoom + 0.1, 2) }
  @objc func zoomOut() { web.pageZoom = max(web.pageZoom - 0.1, 0.6) }

  // ---------- 网页交互 ----------

  func isLocal(_ url: URL) -> Bool {
    guard let s = url.scheme else { return false }
    if ["about", "data", "blob"].contains(s) { return true }
    return (s == "http" || s == "https") && url.host == BASE.host && url.port == PORT
  }

  // 「在 Jira 打开」等 target=_blank 链接：交给默认浏览器
  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
    return nil
  }

  // 附件上传的 <input type=file>
  func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
    let panel = NSOpenPanel()
    panel.allowsMultipleSelection = parameters.allowsMultipleSelection
    panel.canChooseDirectories = parameters.allowsDirectories
    panel.canChooseFiles = true
    panel.beginSheetModal(for: window) { completionHandler($0 == .OK ? panel.urls : nil) }
  }

  func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
    let a = NSAlert()
    a.messageText = message
    a.beginSheetModal(for: window) { _ in completionHandler() }
  }

  func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    let a = NSAlert()
    a.messageText = message
    a.addButton(withTitle: "确定")
    a.addButton(withTitle: "取消")
    a.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
  }

  func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    if navigationAction.shouldPerformDownload { return decisionHandler(.download) }
    guard let url = navigationAction.request.url else { return decisionHandler(.cancel) }
    if isLocal(url) { return decisionHandler(.allow) }
    NSWorkspace.shared.open(url) // 外部链接、mailto 等
    decisionHandler(.cancel)
  }

  func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
    decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
  }

  func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
  func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    if (error as NSError).code == NSURLErrorCancelled { return }
    web.loadHTMLString(Self.page("无法连接本地服务：\(error.localizedDescription)",
      "<p><a href=\"\(BASE.absoluteString)\" style=\"color:#e2561f\">重试</a></p>"), baseURL: nil)
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }

  // ---------- 下载（附件）：存到「下载」文件夹，页面里 toast 提示 ----------

  func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
    let dir = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
    let base = (suggestedFilename as NSString).deletingPathExtension
    let ext = (suggestedFilename as NSString).pathExtension
    var dest = dir.appendingPathComponent(suggestedFilename)
    var n = 1
    while FileManager.default.fileExists(atPath: dest.path) {
      dest = dir.appendingPathComponent(ext.isEmpty ? "\(base) (\(n))" : "\(base) (\(n)).\(ext)")
      n += 1
    }
    downloads[ObjectIdentifier(download)] = dest
    completionHandler(dest)
  }

  func downloadDidFinish(_ download: WKDownload) {
    guard let dest = downloads.removeValue(forKey: ObjectIdentifier(download)) else { return }
    // 让 Dock 里的「下载」堆栈弹跳一下，和浏览器一致
    DistributedNotificationCenter.default().post(name: .init("com.apple.DownloadFileFinished"), object: dest.path)
    notifyPage(["ok": true, "name": dest.lastPathComponent])
  }

  func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
    downloads.removeValue(forKey: ObjectIdentifier(download))
    notifyPage(["ok": false, "error": error.localizedDescription])
  }

  func notifyPage(_ detail: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: detail), let json = String(data: data, encoding: .utf8) else { return }
    web.evaluateJavaScript("window.dispatchEvent(new CustomEvent('wb-native-download',{detail:\(json)}))")
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
