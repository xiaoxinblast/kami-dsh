import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";

const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$appId = 'electron.app.DeepSeek Harness'
$null = [Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]
$null = [Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime]
$data = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())))
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text/><text/></binding></visual><audio src="ms-winsoundevent:Notification.Default"/></toast>')
$nodes = $xml.GetElementsByTagName('text')
$null = $nodes.Item(0).AppendChild($xml.CreateTextNode([string]$data.title))
$null = $nodes.Item(1).AppendChild($xml.CreateTextNode([string]$data.body))
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId)
if ($notifier.Setting.ToString() -ne 'Enabled') { throw ('Windows notifications: ' + $notifier.Setting) }
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
$toast.Tag = [string]$data.tag
$toast.Group = 'kami-batches'
$notifier.Show($toast)
`;

export async function sendWindowsAttention({ batchId, filename, count, label }) {
  if (process.platform !== "win32") return;
  const tag = createHash("sha256").update(batchId).digest("hex").slice(0, 16);
  const payload = { tag, title: "Kami 翻译任务需要处理", body: `${filename}\n${count ? `${count} 段待处理。` : ""}请回到工作台点击“${label}”。` };
  await new Promise((resolve, reject) => {
    const child = spawn(join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
    let errorText = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => { errorText = (errorText + chunk).slice(-1500); });
    const timer = setTimeout(() => { child.kill(); reject(new Error("提交系统通知超时")); }, 15000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(errorText.trim() || `Windows 通知进程退出 ${code}`)); });
    child.stdin.on("error", reject);
    child.stdin.end(Buffer.from(JSON.stringify(payload)).toString("base64"));
  });
  return { tag, group: "kami-batches" };
}
