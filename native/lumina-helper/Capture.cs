using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

namespace Lumina.Helper
{
    /// <summary>Writes length-prefixed packets to stdout: [type:u8][length:u32 LE][payload].</summary>
    internal sealed class PacketWriter
    {
        public const byte Pcm = 1;
        public const byte Json = 2;
        private readonly Stream output = Console.OpenStandardOutput();
        private readonly object gate = new object();
        private readonly byte[] header = new byte[5];

        public void Write(byte type, byte[] payload, int length)
        {
            lock (gate)
            {
                header[0] = type;
                header[1] = (byte)length;
                header[2] = (byte)(length >> 8);
                header[3] = (byte)(length >> 16);
                header[4] = (byte)(length >> 24);
                try
                {
                    output.Write(header, 0, 5);
                    output.Write(payload, 0, length);
                    output.Flush();
                }
                catch (IOException)
                {
                    // The parent closed the pipe: nobody is listening any more.
                    Environment.Exit(0);
                }
            }
        }

        public void Status(string json)
        {
            byte[] bytes = System.Text.Encoding.UTF8.GetBytes(json);
            Write(Json, bytes, bytes.Length);
        }
    }

    /// <summary>Completion handler for ActivateAudioInterfaceAsync (must be agile).</summary>
    [ClassInterface(ClassInterfaceType.None)]
    internal sealed class ActivationHandler : IActivateAudioInterfaceCompletionHandler, IAgileObject
    {
        public readonly ManualResetEvent Done = new ManualResetEvent(false);
        public void ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation)
        {
            Done.Set();
        }
    }

    internal static class SpotifyProcess
    {
        /// <summary>
        /// The root Spotify.exe process (the one whose parent is not Spotify.exe), or 0. Process loopback
        /// with INCLUDE_TARGET_PROCESS_TREE then also captures its child processes.
        /// </summary>
        public static uint FindRoot()
        {
            var names = new Dictionary<uint, string>();
            var parents = new Dictionary<uint, uint>();
            IntPtr snapshot = Native.CreateToolhelp32Snapshot(2 /* TH32CS_SNAPPROCESS */, 0);
            if (snapshot == IntPtr.Zero || snapshot == new IntPtr(-1)) return 0;
            try
            {
                var entry = new PROCESSENTRY32W();
                entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W));
                if (!Native.Process32FirstW(snapshot, ref entry)) return 0;
                do
                {
                    names[entry.th32ProcessID] = entry.szExeFile ?? "";
                    parents[entry.th32ProcessID] = entry.th32ParentProcessID;
                } while (Native.Process32NextW(snapshot, ref entry));
            }
            finally
            {
                Native.CloseHandle(snapshot);
            }
            uint best = 0;
            foreach (var pair in names)
            {
                if (!IsSpotify(pair.Value)) continue;
                string parentName;
                uint parent = parents[pair.Key];
                if (names.TryGetValue(parent, out parentName) && IsSpotify(parentName)) continue;
                if (best == 0 || pair.Key < best) best = pair.Key;
            }
            return best;
        }

        private static bool IsSpotify(string exe)
        {
            return string.Equals(exe, "Spotify.exe", StringComparison.OrdinalIgnoreCase);
        }
    }

    /// <summary>Sample layout of a capture stream.</summary>
    internal sealed class StreamFormat
    {
        public int SampleRate;
        public int Channels;
        public int BitsPerSample;
        public bool IsFloat;
        public int BlockAlign;

        public static StreamFormat FromPointer(IntPtr format)
        {
            var f = new StreamFormat();
            ushort tag = (ushort)Marshal.ReadInt16(format, 0);
            f.Channels = Marshal.ReadInt16(format, 2);
            f.SampleRate = Marshal.ReadInt32(format, 4);
            f.BlockAlign = Marshal.ReadInt16(format, 12);
            f.BitsPerSample = Marshal.ReadInt16(format, 14);
            f.IsFloat = tag == AudioConst.WAVE_FORMAT_IEEE_FLOAT;
            if (tag == AudioConst.WAVE_FORMAT_EXTENSIBLE)
            {
                // WAVEFORMATEXTENSIBLE: SubFormat GUID at offset 24.
                byte[] guid = new byte[16];
                Marshal.Copy(IntPtr.Add(format, 24), guid, 0, 16);
                f.IsFloat = new Guid(guid) == AudioConst.SUBTYPE_IEEE_FLOAT;
            }
            return f;
        }
    }

    /// <summary>
    /// Captures what is playing and writes it to stdout as mono float32 PCM packets. Two sources:
    ///  - process: WASAPI process loopback of Spotify's process tree (Windows 10 2004+). Spotify only.
    ///  - system:  WASAPI loopback of the default output device. Everything that plays, not only Spotify.
    /// "auto" prefers process and falls back to system when process loopback is unavailable.
    /// </summary>
    internal sealed class CaptureLoop
    {
        private const int ProcessRate = 48000;
        /// <summary>Gaps longer than this (no packets: silence on loopback) are filled with zeros.</summary>
        private const double GapFillSeconds = 0.1;
        private readonly PacketWriter writer;
        private readonly string source;
        private readonly int parentPid;
        private volatile bool stopping;
        private float[] mono = new float[4096];
        private byte[] packet = new byte[16384];

        public CaptureLoop(PacketWriter writer, string source, int parentPid)
        {
            this.writer = writer;
            this.source = source;
            this.parentPid = parentPid;
        }

        public void Stop()
        {
            stopping = true;
        }

        public void Run()
        {
            bool processFailed = false;
            while (!stopping)
            {
                if (!ParentAlive()) return;
                bool wantProcess = source == "spotify" || (source == "auto" && !processFailed);
                if (wantProcess)
                {
                    uint pid = SpotifyProcess.FindRoot();
                    if (pid == 0)
                    {
                        Report("waiting", "process", 0, 0, "Spotify is not running");
                        // Auto: light up from all system audio until Spotify starts, then switch back.
                        if (source == "auto") RunSystem(delegate { return SpotifyProcess.FindRoot() == 0; });
                        else Sleep(2000);
                        continue;
                    }
                    string error = RunProcess(pid);
                    if (error == null) continue; // Spotify exited or restarted: look again.
                    Report("error", "process", pid, 0, error);
                    if (source == "auto") processFailed = true;
                    else Sleep(3000);
                    continue;
                }
                RunSystem(delegate { return true; });
                if (!stopping) Sleep(1000);
            }
        }

        private bool ParentAlive()
        {
            if (parentPid <= 0) return true;
            try
            {
                Process.GetProcessById(parentPid);
                return true;
            }
            catch (ArgumentException)
            {
                stopping = true;
                return false;
            }
        }

        private void Sleep(int ms)
        {
            for (int waited = 0; waited < ms && !stopping; waited += 100) Thread.Sleep(100);
        }

        private void Report(string state, string mode, uint pid, int rate, string message)
        {
            writer.Status("{\"type\":\"status\",\"state\":\"" + state + "\",\"mode\":\"" + mode + "\",\"pid\":" + pid +
                ",\"sampleRate\":" + rate + ",\"message\":\"" + Escape(message) + "\"}");
        }

        private static string Escape(string s)
        {
            if (s == null) return "";
            return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", " ").Replace("\n", " ");
        }

        /// <summary>Captures Spotify's process tree until it exits. Returns null, or an error description.</summary>
        private string RunProcess(uint pid)
        {
            IntPtr paramsPtr = IntPtr.Zero, propPtr = IntPtr.Zero, formatPtr = IntPtr.Zero;
            IAudioClient client = null;
            try
            {
                // AUDIOCLIENT_ACTIVATION_PARAMS { PROCESS_LOOPBACK, { pid, INCLUDE_TARGET_PROCESS_TREE } }
                paramsPtr = Marshal.AllocHGlobal(12);
                Marshal.WriteInt32(paramsPtr, 0, 1);
                Marshal.WriteInt32(paramsPtr, 4, (int)pid);
                Marshal.WriteInt32(paramsPtr, 8, 0);
                // PROPVARIANT { VT_BLOB, { cbSize, pBlobData } }
                propPtr = Marshal.AllocHGlobal(24);
                for (int i = 0; i < 24; i += 4) Marshal.WriteInt32(propPtr, i, 0);
                Marshal.WriteInt16(propPtr, 0, (short)AudioConst.VT_BLOB);
                Marshal.WriteInt32(propPtr, 8, 12);
                Marshal.WriteIntPtr(propPtr, 16, paramsPtr);

                var handler = new ActivationHandler();
                IActivateAudioInterfaceAsyncOperation op;
                int hr = Native.ActivateAudioInterfaceAsync(AudioConst.VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
                    AudioConst.IID_IAudioClient, propPtr, handler, out op);
                if (hr != Hr.S_OK) return "process loopback unavailable (0x" + hr.ToString("X8") + ")";
                if (!handler.Done.WaitOne(5000)) return "process loopback activation timed out";
                int activateHr;
                object activated;
                hr = op.GetActivateResult(out activateHr, out activated);
                if (hr != Hr.S_OK || activateHr != Hr.S_OK || activated == null)
                    return "process loopback activation failed (0x" + (hr != 0 ? hr : activateHr).ToString("X8") + ")";
                client = (IAudioClient)activated;

                // Process loopback has no mix format: ask for 16-bit stereo and let Windows convert.
                formatPtr = Marshal.AllocHGlobal(18);
                Marshal.WriteInt16(formatPtr, 0, (short)AudioConst.WAVE_FORMAT_PCM);
                Marshal.WriteInt16(formatPtr, 2, 2);
                Marshal.WriteInt32(formatPtr, 4, ProcessRate);
                Marshal.WriteInt32(formatPtr, 8, ProcessRate * 4);
                Marshal.WriteInt16(formatPtr, 12, 4);
                Marshal.WriteInt16(formatPtr, 14, 16);
                Marshal.WriteInt16(formatPtr, 16, 0);
                var format = StreamFormat.FromPointer(formatPtr);
                uint flags = AudioConst.AUDCLNT_STREAMFLAGS_LOOPBACK | AudioConst.AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
                    AudioConst.AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AudioConst.AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
                hr = client.Initialize(AudioConst.AUDCLNT_SHAREMODE_SHARED, flags, 200000, 0, formatPtr, IntPtr.Zero);
                if (hr != Hr.S_OK) return "process loopback initialize failed (0x" + hr.ToString("X8") + ")";

                Report("capturing", "process", pid, format.SampleRate, "Capturing Spotify only");
                string end = Pump(client, format, true, delegate
                {
                    return SpotifyProcess.FindRoot() == pid;
                });
                return end;
            }
            catch (Exception e)
            {
                return "process loopback failed: " + e.Message;
            }
            finally
            {
                if (client != null) Marshal.ReleaseComObject(client);
                if (formatPtr != IntPtr.Zero) Marshal.FreeHGlobal(formatPtr);
                if (propPtr != IntPtr.Zero) Marshal.FreeHGlobal(propPtr);
                if (paramsPtr != IntPtr.Zero) Marshal.FreeHGlobal(paramsPtr);
            }
        }

        /// <summary>Captures the default output device while `keepGoing` holds and the device stays the default.</summary>
        private void RunSystem(StillValid keepGoing)
        {
            IMMDeviceEnumerator enumerator = null;
            IMMDevice device = null;
            IAudioClient client = null;
            IntPtr mixFormat = IntPtr.Zero;
            try
            {
                enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorCom();
                int hr = enumerator.GetDefaultAudioEndpoint(0 /* eRender */, 0 /* eConsole */, out device);
                if (hr != Hr.S_OK || device == null)
                {
                    Report("waiting", "system", 0, 0, "No audio output device");
                    Sleep(2000);
                    return;
                }
                string deviceId;
                device.GetId(out deviceId);
                object instance;
                hr = device.Activate(AudioConst.IID_IAudioClient, AudioConst.CLSCTX_ALL, IntPtr.Zero, out instance);
                if (hr != Hr.S_OK)
                {
                    Report("error", "system", 0, 0, "Cannot open the output device (0x" + hr.ToString("X8") + ")");
                    Sleep(2000);
                    return;
                }
                client = (IAudioClient)instance;
                hr = client.GetMixFormat(out mixFormat);
                if (hr != Hr.S_OK)
                {
                    Report("error", "system", 0, 0, "No mix format (0x" + hr.ToString("X8") + ")");
                    Sleep(2000);
                    return;
                }
                var format = StreamFormat.FromPointer(mixFormat);
                if (!(format.IsFloat && format.BitsPerSample == 32) && format.BitsPerSample != 16 && format.BitsPerSample != 32)
                {
                    Report("error", "system", 0, 0, "Unsupported mix format (" + format.BitsPerSample + "-bit)");
                    Sleep(5000);
                    return;
                }
                hr = client.Initialize(AudioConst.AUDCLNT_SHAREMODE_SHARED, AudioConst.AUDCLNT_STREAMFLAGS_LOOPBACK, 2000000, 0, mixFormat, IntPtr.Zero);
                if (hr != Hr.S_OK)
                {
                    Report("error", "system", 0, 0, "Loopback initialize failed (0x" + hr.ToString("X8") + ")");
                    Sleep(2000);
                    return;
                }
                Report("capturing", "system", 0, format.SampleRate, "Capturing all system audio");
                var enumRef = enumerator;
                string end = Pump(client, format, false, delegate
                {
                    if (!keepGoing()) return false;
                    // The default device changed (headphones plugged in, Bluetooth connected): reopen.
                    IMMDevice current;
                    if (enumRef.GetDefaultAudioEndpoint(0, 0, out current) != Hr.S_OK || current == null) return false;
                    string currentId;
                    current.GetId(out currentId);
                    Marshal.ReleaseComObject(current);
                    return currentId == deviceId;
                });
                if (end != null) Report("error", "system", 0, 0, end);
            }
            catch (Exception e)
            {
                Report("error", "system", 0, 0, "Loopback failed: " + e.Message);
                Sleep(2000);
            }
            finally
            {
                if (mixFormat != IntPtr.Zero) Marshal.FreeCoTaskMem(mixFormat);
                if (client != null) Marshal.ReleaseComObject(client);
                if (device != null) Marshal.ReleaseComObject(device);
                if (enumerator != null) Marshal.ReleaseComObject(enumerator);
            }
        }

        private delegate bool StillValid();

        /// <summary>
        /// Reads packets until `stillValid` (checked about once a second) says stop, or the stream fails.
        /// Returns null when stopped normally, or an error description.
        /// </summary>
        private string Pump(IAudioClient client, StreamFormat format, bool useEvent, StillValid stillValid)
        {
            object service;
            int hr = client.GetService(AudioConst.IID_IAudioCaptureClient, out service);
            if (hr != Hr.S_OK) return "GetService failed (0x" + hr.ToString("X8") + ")";
            var capture = (IAudioCaptureClient)service;
            var signal = new AutoResetEvent(false);
            try
            {
                if (useEvent)
                {
                    hr = client.SetEventHandle(signal.SafeWaitHandle.DangerousGetHandle());
                    if (hr != Hr.S_OK) useEvent = false;
                }
                hr = client.Start();
                if (hr != Hr.S_OK) return "Start failed (0x" + hr.ToString("X8") + ")";
                var clock = Stopwatch.StartNew();
                long emitted = 0;
                long lastCheck = 0;
                while (!stopping)
                {
                    if (useEvent) signal.WaitOne(50);
                    else Thread.Sleep(10);

                    uint packetFrames;
                    hr = capture.GetNextPacketSize(out packetFrames);
                    if (hr != Hr.S_OK) return hr == Hr.AUDCLNT_E_DEVICE_INVALIDATED ? null : "GetNextPacketSize failed (0x" + hr.ToString("X8") + ")";
                    while (packetFrames > 0)
                    {
                        IntPtr data;
                        uint frames, flags;
                        ulong devicePos, qpcPos;
                        hr = capture.GetBuffer(out data, out frames, out flags, out devicePos, out qpcPos);
                        if (hr != Hr.S_OK) return hr == Hr.AUDCLNT_E_DEVICE_INVALIDATED ? null : "GetBuffer failed (0x" + hr.ToString("X8") + ")";
                        Emit(data, (int)frames, format, (flags & AudioConst.AUDCLNT_BUFFERFLAGS_SILENT) != 0);
                        emitted += frames;
                        capture.ReleaseBuffer(frames);
                        hr = capture.GetNextPacketSize(out packetFrames);
                        if (hr != Hr.S_OK) break;
                    }

                    // Loopback delivers nothing while nothing plays; keep time moving with silence.
                    long expected = (long)(clock.Elapsed.TotalSeconds * format.SampleRate);
                    if (expected - emitted > format.SampleRate * GapFillSeconds)
                    {
                        int fill = (int)Math.Min(expected - emitted - format.SampleRate / 50, format.SampleRate);
                        if (fill > 0)
                        {
                            Emit(IntPtr.Zero, fill, format, true);
                            emitted += fill;
                        }
                    }
                    else if (emitted - expected > format.SampleRate)
                    {
                        emitted = expected; // A burst after a stall: resync instead of drifting.
                    }

                    if (clock.ElapsedMilliseconds - lastCheck >= 1000)
                    {
                        lastCheck = clock.ElapsedMilliseconds;
                        if (!ParentAlive() || !stillValid()) return null;
                    }
                }
                return null;
            }
            finally
            {
                client.Stop();
                Marshal.ReleaseComObject(capture);
                signal.Dispose();
            }
        }

        /// <summary>Downmixes `frames` to mono float32 and writes one PCM packet.</summary>
        private void Emit(IntPtr data, int frames, StreamFormat format, bool silent)
        {
            if (frames <= 0) return;
            if (mono.Length < frames) mono = new float[frames];
            if (silent || data == IntPtr.Zero)
            {
                Array.Clear(mono, 0, frames);
            }
            else
            {
                int channels = Math.Max(1, format.Channels);
                int bytesPerSample = format.BitsPerSample / 8;
                float scale = 1f / channels;
                unsafe
                {
                    byte* p = (byte*)data.ToPointer();
                    for (int i = 0; i < frames; i++)
                    {
                        float sum = 0;
                        byte* frame = p + i * format.BlockAlign;
                        for (int c = 0; c < channels; c++)
                        {
                            byte* s = frame + c * bytesPerSample;
                            if (format.IsFloat) sum += *(float*)s;
                            else if (bytesPerSample == 2) sum += *(short*)s / 32768f;
                            else sum += *(int*)s / 2147483648f;
                        }
                        mono[i] = sum * scale;
                    }
                }
            }
            int bytes = frames * 4;
            if (packet.Length < bytes) packet = new byte[bytes];
            Buffer.BlockCopy(mono, 0, packet, 0, bytes);
            writer.Write(PacketWriter.Pcm, packet, bytes);
        }
    }
}
