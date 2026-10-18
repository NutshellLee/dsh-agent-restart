// 2026-10-18：agent 重启工作流，独立小插件。
// 职责只有一件：让 agent 能重启应用，并在重启后把没做完的事带回来。
// 不碰 DSH 核心；重启靠外部助手进程（WMI 创建，脱离应用进程树）。
import { existsSync, readFileSync, statSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

export const name = "agent-restart";
export const inject = ["tools"];

const WORK_DIR = () => join(process.env.LOCALAPPDATA || homedir(), "dsh-voice-mode");
const JOURNAL = () => join(WORK_DIR(), "restart-journal.json");
const FLAG = () => join(WORK_DIR(), "agent-restart.flag");
const VOICE_RESUME = () => join(WORK_DIR(), "voice-resume.json");
const LOG = () => join(WORK_DIR(), "restart.log");
const FRESH_MS = 10 * 60 * 1000;

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function logSize() {
  try {
    return statSync(LOG()).size;
  } catch {
    return -1;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function apply(ctx) {
  // 启动时：只有 agent 自己重启才会留下这个一次性标记；用户手动开应用没有标记，什么都不做。
  let resume = null;
  try {
    const fresh = existsSync(FLAG()) && Date.now() - statSync(FLAG()).mtimeMs < FRESH_MS;
    if (fresh) {
      const journal = readJson(JOURNAL());
      if (journal && journal.state === "restarting") {
        resume = {
          pending: typeof journal.pending === "string" ? journal.pending : "",
          voiceActive: journal.voiceActive === true,
          voiceSessionId: typeof journal.voiceSessionId === "string" ? journal.voiceSessionId : null,
          sessionId: typeof journal.sessionId === "string" ? journal.sessionId : typeof journal.voiceSessionId === "string" ? journal.voiceSessionId : null,
          loadedAt: Date.now()
        };
        // 交给语音插件：它只负责"把语音开回来"，不碰重启逻辑。
        try {
          mkdirSync(WORK_DIR(), { recursive: true });
          writeFileSync(VOICE_RESUME(), JSON.stringify({ sessionId: resume.voiceSessionId, at: new Date().toISOString() }), "utf8");
        } catch {
        }
        console.log("[agent-restart] 重启续做已装载 voice=" + String(resume.voiceActive) + " pending=" + resume.pending.slice(0, 60));
      }
    }
  } catch {
  }
  // 标记一次性：读完就删，避免以后手动启动时误触发。
  try {
    if (existsSync(FLAG())) rmSync(FLAG(), { force: true });
  } catch {
  }

  // 2026-10-18：应用彻底起来后 5 秒，排一条续跑消息开一个新回合接着干（只排一次，不做目标、不标完成）。
  // 触发点是“宿主已就绪 + 5 秒”，失败会重试几次。来源标记是 restart，不是 user。
  const createSelfMessage = (text) => {
    const deepFreeze = (value) => {
      Object.freeze(value);
      for (const child of Object.values(value)) if (child && typeof child === "object") deepFreeze(child);
      return value;
    };
    return deepFreeze(structuredClone({
      id: randomUUID(),
      role: "user",
      content: [{ type: "text", text }],
      // 来源标记不是 user：界面上它会走“收到执行请求”的系统提示样式，不是用户气泡。
      source: { kind: "restart" }
    }));
  };
  const kickContinuation = async () => {
    if (!resume || !resume.pending) return;
    const sessionId = resume.sessionId;
    if (!sessionId) {
      console.log("[agent-restart] 没有会话 id，跳过自动续跑");
      return;
    }
    const controller = ctx.get("sessionController");
    const sessions = ctx.get("sessions");
    if (!controller || typeof controller.resolveAgent !== "function") {
      console.log("[agent-restart] sessionController 不可用，跳过自动续跑");
      return;
    }
    try {
      const resolved = await controller.resolveAgent(sessionId);
      if (resolved && "error" in resolved) throw resolved.error;
      const text = "【重启续做】应用已经重启完成。上次没做完的事：" + resume.pending + "\n现在直接接着做，完成后汇报验证结果。";
      resolved.agent.followup(createSelfMessage(text));
      if (sessions && typeof sessions.flush === "function") await sessions.flush(resolved.agent.session);
      resume.pending = "";
      try {
        const fsp = await import("node:fs/promises");
        const journal = JSON.parse(await fsp.readFile(JOURNAL(), "utf8"));
        journal.state = "continued";
        journal.continuedAt = new Date().toISOString();
        await fsp.writeFile(JOURNAL(), JSON.stringify(journal, null, 2), "utf8");
      } catch {
      }
      console.log("[agent-restart] 已自动续跑：新回合已排队");
    } catch (e) {
      console.log("[agent-restart] 自动续跑失败：" + String((e && e.message) || e));
    }
  };
  if (resume && resume.pending) {
    let attempts = 0;
    const timer = setTimeout(function tryKick() {
      attempts += 1;
      void kickContinuation().then(() => {
        if (resume.pending && attempts < 6) timer = setTimeout(tryKick, 3000);
      });
    }, 5000);
    timer.unref?.();
  }


  const activeVoiceSession = () => {
    try {
      const getter = ctx.get("voiceActiveSession");
      return typeof getter === "function" ? getter() : null;
    } catch {
      return null;
    }
  };

  ctx.inject(["tools"], (scoped) => {
    const off = scoped.tools.register({
      name: "restart_harness",
      description: "重启 DeepSeek Harness。写重启日志，然后用外部助手（WMI 创建，脱离应用进程树）杀掉应用并重新拉起；重启后待办会自动回到上下文，语音会由语音插件自动恢复。返回 ok 表示助手确实已经起来（以 restart.log 新行和进程启动时间为准）。",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string", description: "为什么重启" },
          pending: { type: "string", description: "重启后接着要做什么" }
        },
        required: ["reason"]
      },
      output: {
        schema: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            journal: { type: "string" },
            error: { type: "string" }
          },
          required: ["ok"]
        },
        render: (result) => [{ type: "text", text: JSON.stringify(result) }]
      },
      execute: async (args, exec) => {
        const reason = String((args && args.reason) || "restart");
        const pending = String((args && args.pending) || "");
        const dir = WORK_DIR();
        try {
          mkdirSync(dir, { recursive: true });
        } catch {
        }
        const voiceSid = activeVoiceSession();
        let sessionId = null;
        try {
          sessionId = exec && exec.agent && exec.agent.session ? exec.agent.session.id : null;
        } catch {
        }
        await new Promise((resolve) => {
          import("node:fs/promises").then((fsp) =>
            fsp.writeFile(JOURNAL(), JSON.stringify({
              state: "restarting",
              reason,
              pending,
              requestedAt: new Date().toISOString(),
              voiceActive: voiceSid !== null && voiceSid !== void 0,
              voiceSessionId: typeof voiceSid === "string" ? voiceSid : null,
            sessionId: typeof sessionId === "string" ? sessionId : typeof voiceSid === "string" ? voiceSid : null,
              checks: []
            }, null, 2), "utf8")
          ).then(resolve, resolve);
        });

        const exe = process.execPath;
        const helper = join(dir, "restart-helper.ps1");
        const launcher = join(dir, "restart-launch.ps1");
        const helperPs = [
          "param([int]$Delay = 8)",
          "$log = '" + LOG().replace(/'/g, "''") + "'",
          "function L($m) { \"$(Get-Date -Format o) $m\" | Out-File -FilePath $log -Append -Encoding utf8 }",
          "L \"tool-restart delay=$Delay\"",
          "Start-Sleep -Seconds $Delay",
          "L \"force killing\"",
          "Get-Process -Name 'DSH NEXT' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue",
          "$deadline = (Get-Date).AddSeconds(60)",
          "while ((Get-Process -Name 'DSH NEXT' -ErrorAction SilentlyContinue) -and ((Get-Date) -lt $deadline)) { Start-Sleep -Milliseconds 500 }",
          "Start-Sleep -Seconds 3",
          "L \"starting app\"",
          "Set-Content -Path '" + FLAG().replace(/'/g, "''") + "' -Value (Get-Date -Format o) -Encoding utf8",
          "$shell = Join-Path $env:SystemRoot 'explorer.exe'",,
          "& $shell '" + exe.replace(/'/g, "''") + "'",
          "L \"tool-restart done\""
        ].join("\n");
        // 启动器单独成文件：宿主里 spawn 传参时双引号会被吃掉，用 -File 最稳。
        const launcherPs = "Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Minimized -File " + helper + " -Delay 8' } | Out-Null\n";
        try {
          const fsp = await import("node:fs/promises");
          await fsp.writeFile(helper, helperPs, "utf8");
          await fsp.writeFile(launcher, launcherPs, "utf8");
        } catch (e) {
          return { ok: false, journal: JOURNAL(), error: "写助手脚本失败：" + String((e && e.message) || e) };
        }

        const before = logSize();
        try {
          const sysRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
          const psExe = join(sysRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
          const child = spawn(psExe, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Minimized", "-File", launcher], {
            detached: true,
            stdio: "ignore",
            windowsHide: true
          });
          child.on("error", (e) => console.log("[agent-restart] 启动器 spawn 失败：" + String((e && e.message) || e)));
          child.unref();
        } catch (e) {
          return { ok: false, journal: JOURNAL(), error: "拉起启动器失败：" + String((e && e.message) || e) };
        }

        // 助手一起来就会先写一行日志。2.5 秒内日志没长，就是没起来——如实报失败，不给假 ok。
        await sleep(2500);
        if (logSize() <= before) {
          return { ok: false, journal: JOURNAL(), error: "启动器没有跑起来（restart.log 没有新行），应用未重启。请改用外部 pwsh 发 WMI 调用来重启。" };
        }
        return { ok: true, journal: JOURNAL() };
      }
    });
    if (typeof off === "function") ctx.effect(() => off);
    console.log("[agent-restart] 重启动口已注册");
  });
}
