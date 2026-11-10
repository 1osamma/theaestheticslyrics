using System;
using System.Diagnostics;
using System.Text;
using System.Threading;

namespace Lumina.Helper
{
    /// <summary>
    /// lumina-helper.exe: LUMINA's small native companion. Runs as the user (never elevated).
    ///   capture    --source auto|spotify|system --parent PID   PCM + status packets on stdout
    ///   fullscreen --exclude PID --parent PID                   one JSON line per change on stdout
    ///   probe      HWND X Y                                     window styles and hit test, for tests
    /// Closing stdin, or the parent exiting, stops it.
    /// </summary>
    internal static class Program
    {
        [MTAThread]
        private static int Main(string[] args)
        {
            try { Native.SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (Exception) { }
            string command = args.Length > 0 ? args[0] : "";
            int parent = IntArg(args, "--parent", 0);
            switch (command)
            {
                case "capture":
                    return Capture(Arg(args, "--source", "auto"), parent);
                case "fullscreen":
                    return Fullscreen(IntArg(args, "--exclude", 0), parent, IntArg(args, "--interval", 1000));
                case "probe":
                    return Probe(args);
                default:
                    Console.Error.WriteLine("usage: lumina-helper capture|fullscreen|probe");
                    return 2;
            }
        }

        private static string Arg(string[] args, string name, string fallback)
        {
            for (int i = 0; i + 1 < args.Length; i++) if (args[i] == name) return args[i + 1];
            return fallback;
        }

        private static int IntArg(string[] args, string name, int fallback)
        {
            int value;
            return int.TryParse(Arg(args, name, ""), out value) ? value : fallback;
        }

        /// <summary>Stops the helper when the parent closes our stdin.</summary>
        private static void WatchStdin(Action onClose)
        {
            var thread = new Thread(delegate ()
            {
                try
                {
                    var input = Console.OpenStandardInput();
                    var buffer = new byte[64];
                    while (input.Read(buffer, 0, buffer.Length) > 0) { }
                }
                catch (Exception) { }
                onClose();
            });
            thread.IsBackground = true;
            thread.Start();
        }

        private static int Capture(string source, int parent)
        {
            if (source != "auto" && source != "spotify" && source != "system") source = "auto";
            var writer = new PacketWriter();
            var loop = new CaptureLoop(writer, source, parent);
            WatchStdin(delegate { loop.Stop(); });
            writer.Status("{\"type\":\"hello\",\"source\":\"" + source + "\",\"os\":\"" + Environment.OSVersion.Version + "\"}");
            loop.Run();
            return 0;
        }

        private static readonly string[] ShellClasses = { "Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd" };

        /// <summary>
        /// Reports whether another app fills a monitor (borderless or exclusive full screen): a game, a
        /// video player, a presentation. Windows of the `exclude` process (LUMINA itself) never count.
        /// </summary>
        private static int Fullscreen(int exclude, int parent, int interval)
        {
            bool stop = false;
            WatchStdin(delegate { stop = true; });
            string last = null;
            var sinceEmit = Stopwatch.StartNew();
            while (!stop)
            {
                if (parent > 0)
                {
                    try { Process.GetProcessById(parent); }
                    catch (ArgumentException) { return 0; }
                }
                string line = FullscreenState(exclude);
                if (line != last || sinceEmit.ElapsedMilliseconds > 10000)
                {
                    last = line;
                    sinceEmit.Restart();
                    try
                    {
                        Console.Out.WriteLine(line);
                        Console.Out.Flush();
                    }
                    catch (Exception) { return 0; }
                }
                Thread.Sleep(Math.Max(250, interval));
            }
            return 0;
        }

        private static string FullscreenState(int exclude)
        {
            int quns;
            if (Native.SHQueryUserNotificationState(out quns) != 0) quns = 0;
            IntPtr fg = Native.GetForegroundWindow();
            if (fg == IntPtr.Zero) return Json(false, quns, null, 0);
            uint pid;
            Native.GetWindowThreadProcessId(fg, out pid);
            var cls = new StringBuilder(256);
            Native.GetClassNameW(fg, cls, cls.Capacity);
            if ((int)pid == exclude || Array.IndexOf(ShellClasses, cls.ToString()) >= 0) return Json(false, quns, null, pid);
            if (!Native.IsWindowVisible(fg) || Native.IsIconic(fg)) return Json(false, quns, null, pid);
            RECT wr;
            if (!Native.GetWindowRect(fg, out wr)) return Json(false, quns, null, pid);
            var mi = new MONITORINFO();
            mi.cbSize = System.Runtime.InteropServices.Marshal.SizeOf(typeof(MONITORINFO));
            IntPtr monitor = Native.MonitorFromWindow(fg, 2 /* MONITOR_DEFAULTTONEAREST */);
            if (!Native.GetMonitorInfoW(monitor, ref mi)) return Json(false, quns, null, pid);
            var m = mi.rcMonitor;
            bool covers = wr.Left <= m.Left && wr.Top <= m.Top && wr.Right >= m.Right && wr.Bottom >= m.Bottom;
            // A maximized window (title bar, frame overhanging the monitor) is not full screen; browsers in
            // F11, video players and borderless games drop WS_CAPTION when they take the whole monitor.
            long style = Native.GetWindowLongPtr(fg, -16 /* GWL_STYLE */).ToInt64();
            bool captioned = (style & 0x00C00000L) == 0x00C00000L;
            // QUNS_RUNNING_D3D_FULL_SCREEN: an exclusive full-screen game, whatever its window rect says.
            bool active = (covers && !captioned) || quns == 3;
            return Json(active, quns, active ? (RECT?)m : null, pid);
        }

        private static string Json(bool active, int quns, RECT? monitor, uint pid)
        {
            string rect = monitor.HasValue
                ? "{\"x\":" + monitor.Value.Left + ",\"y\":" + monitor.Value.Top + ",\"width\":" + (monitor.Value.Right - monitor.Value.Left) +
                  ",\"height\":" + (monitor.Value.Bottom - monitor.Value.Top) + "}"
                : "null";
            return "{\"type\":\"fullscreen\",\"active\":" + (active ? "true" : "false") + ",\"quns\":" + quns + ",\"pid\":" + pid +
                ",\"monitor\":" + rect + "}";
        }

        /// <summary>Prints a window's extended styles and which window a click at (x, y) would reach.</summary>
        private static int Probe(string[] args)
        {
            long hwndValue;
            int x, y;
            if (args.Length < 4 || !long.TryParse(args[1], out hwndValue) || !int.TryParse(args[2], out x) || !int.TryParse(args[3], out y))
            {
                Console.Error.WriteLine("usage: lumina-helper probe HWND X Y");
                return 2;
            }
            var hwnd = new IntPtr(hwndValue);
            long ex = Native.GetWindowLongPtr(hwnd, -20 /* GWL_EXSTYLE */).ToInt64();
            var pt = new POINT();
            pt.X = x;
            pt.Y = y;
            IntPtr hit = Native.GetAncestor(Native.WindowFromPoint(pt), 2 /* GA_ROOT */);
            Console.Out.WriteLine("{\"exStyle\":" + ex +
                ",\"transparent\":" + ((ex & 0x20) != 0 ? "true" : "false") +
                ",\"layered\":" + ((ex & 0x80000) != 0 ? "true" : "false") +
                ",\"toolWindow\":" + ((ex & 0x80) != 0 ? "true" : "false") +
                ",\"noActivate\":" + ((ex & 0x08000000) != 0 ? "true" : "false") +
                ",\"appWindow\":" + ((ex & 0x40000) != 0 ? "true" : "false") +
                ",\"topmost\":" + ((ex & 0x8) != 0 ? "true" : "false") +
                ",\"hitIsWindow\":" + (hit == hwnd ? "true" : "false") + ",\"hit\":" + hit.ToInt64() + "}");
            return 0;
        }
    }
}
