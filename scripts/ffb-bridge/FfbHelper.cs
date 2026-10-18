// FfbHelper: DirectInput constant-force driver behind the sim's wheel force feedback (Windows).
//
// A browser cannot play DirectInput force feedback, so scripts/ffb-bridge.ts receives the sim's steering torque
// over a localhost WebSocket and pipes it here. This program owns the wheel's force feedback the way a native
// sim does (exclusive background access, autocentre spring off, one constant-force effect whose magnitude is
// updated ~333 times a second), following Microsoft's FFConst sample and SDL's DirectInput haptic backend.
// Built by the bridge with the .NET Framework's csc.exe (C# 5, no packages).
//
// Usage:  FfbHelper [--device <name part>] [--max 0..1] [--rate <Hz>] [--direction 1|0]
//         FfbHelper --list       game controllers and their force-feedback support (read-only)
//         FfbHelper --info       each force-feedback device's axes and constant-force support (read-only)
//
// --direction: the effect's Cartesian direction on the steering axis. 1 (default) is the explicit +X vector, which
// every driver resolves (Moza's own driver puts no force on the wheel for Microsoft's FFConst-sample 0); 0 is that
// sample's convention, for a wheel whose driver only accepts it.
//         FfbHelper --dry-run    no wheel: run the pipeline and log what would be sent
//
// stdin (one line per sim frame, from the bridge):
//   F <force> <kerb> <abs>   force -1..1 (+ = turn the rim right), kerb / ABS vibration levels 0..1
//   T [sign]                 direction test: pulls right for a second, then left (the other way round with sign -1,
//                            the sim's Invert setting, so the test shows what the game's forces will do)
//   Z                        zero now (the sim disconnected)
//   Q                        quit
// stdout:
//   STATUS {json}            {"ok":true,"device":"...","axes":1} / {"ok":false,"error":"..."}
//   LOG <text>
//
// Safety: the force fades to zero when no packet arrives for WATCHDOG_MS (tab hidden, sim paused or crashed),
// is capped at --max, slew-limited, and the effect is stopped on exit (also on Ctrl+C).

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class FfbHelper
{
    // ---- Tuning
    const int WATCHDOG_MS = 150;
    /** Upsampling low-pass for the frame-rate force (s) */
    const double SMOOTH_TAU_S = 0.004;
    /** Output slew limit (full scale per second): fast enough for the kerb buzz, never an instant full-lock jolt */
    const double SLEW_PER_S = 85;
    const double KERB_HZ = 36, KERB_AMPLITUDE = 0.5;
    const double ABS_HZ = 16, ABS_AMPLITUDE = 0.4;
    /** Direction test: a held pull each way (s, s between, fraction of --max) */
    const double TEST_PULL_S = 1.0, TEST_GAP_S = 0.3, TEST_LEVEL = 0.25;

    // ---- DirectInput
    const int DIRECTINPUT_VERSION = 0x0800;
    const uint DI8DEVCLASS_GAMECTRL = 4;
    const uint DIEDFL_ATTACHEDONLY = 0x1;
    const uint DIEDFL_FORCEFEEDBACK = 0x100;
    const uint DIDC_FORCEFEEDBACK = 0x100;
    const uint DISCL_EXCLUSIVE = 0x1;
    const uint DISCL_BACKGROUND = 0x8;
    const uint DIDFT_AXIS = 0x3;
    const uint DIDFT_POV = 0x10;
    const uint DIDFT_BUTTON = 0xC;
    const uint DIDFT_ANYINSTANCE = 0x00FFFF00;
    const uint DIDFT_OPTIONAL = 0x80000000;
    const uint DIDOI_FFACTUATOR = 0x1;
    const int DIDF_ABSAXIS = 0x1;
    const uint DIEFF_OBJECTOFFSETS = 0x2;
    const uint DIEFF_CARTESIAN = 0x10;
    const uint DIEP_TYPESPECIFICPARAMS = 0x100;
    const uint INFINITE = 0xFFFFFFFF;
    const uint DIEB_NOTRIGGER = 0xFFFFFFFF;
    const uint DISFFC_RESET = 0x1;
    const uint DISFFC_SETACTUATORSON = 0x10;
    const int DIPROP_FFGAIN = 7;
    const int DIPROP_AUTOCENTER = 9;
    const int DI_FFNOMINALMAX = 10000;
    const uint DI8DEVTYPE_DRIVING = 0x16;
    const int DIERR_OTHERAPPHASPRIO = unchecked((int)0x80070005);
    const uint WS_POPUP = 0x80000000;

    static readonly Guid IID_IDirectInput8W = new Guid("BF798031-483A-4DA2-AA99-5D64ED369700");
    static readonly Guid GUID_ConstantForce = new Guid("13541C20-8E33-11D0-9AD0-00A0C9A06E35");
    static readonly Guid GUID_XAxis = new Guid("A36D02E0-C9F3-11CF-BFC7-444553540000");
    static readonly Guid GUID_YAxis = new Guid("A36D02E1-C9F3-11CF-BFC7-444553540000");
    static readonly Guid GUID_ZAxis = new Guid("A36D02E2-C9F3-11CF-BFC7-444553540000");
    static readonly Guid GUID_RxAxis = new Guid("A36D02F4-C9F3-11CF-BFC7-444553540000");
    static readonly Guid GUID_RyAxis = new Guid("A36D02F5-C9F3-11CF-BFC7-444553540000");
    static readonly Guid GUID_RzAxis = new Guid("A36D02E3-C9F3-11CF-BFC7-444553540000");
    static readonly Guid GUID_Slider = new Guid("A36D02E4-C9F3-11CF-BFC7-444553540000");
    static readonly Guid GUID_POV = new Guid("A36D02F2-C9F3-11CF-BFC7-444553540000");
    /** The six axes in c_dfDIJoystick order: DIJOFS_X .. DIJOFS_RZ = 0, 4 .. 20 */
    static readonly Guid[] AXIS_GUIDS = { GUID_XAxis, GUID_YAxis, GUID_ZAxis, GUID_RxAxis, GUID_RyAxis, GUID_RzAxis };
    static readonly string[] AXIS_NAMES = { "X", "Y", "Z", "Rx", "Ry", "Rz" };

    // vtable slots (IUnknown: 0 QueryInterface, 1 AddRef, 2 Release)
    const int DI_CreateDevice = 3, DI_EnumDevices = 4;
    const int DEV_GetCapabilities = 3, DEV_EnumObjects = 4, DEV_SetProperty = 6, DEV_Acquire = 7, DEV_Unacquire = 8;
    const int DEV_SetDataFormat = 11, DEV_SetCooperativeLevel = 13, DEV_CreateEffect = 18, DEV_GetEffectInfo = 20, DEV_SendForceFeedbackCommand = 22, DEV_Poll = 25;
    const int EFF_SetParameters = 6, EFF_Start = 7, EFF_Stop = 8, EFF_Unload = 11;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct DIDEVICEINSTANCEW
    {
        public uint dwSize;
        public Guid guidInstance;
        public Guid guidProduct;
        public uint dwDevType;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string tszInstanceName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string tszProductName;
        public Guid guidFFDriver;
        public ushort wUsagePage;
        public ushort wUsage;
    }

    /** Leading fields of DIDEVICEOBJECTINSTANCEW (all the axis callback reads) */
    [StructLayout(LayoutKind.Sequential)]
    struct DIDEVICEOBJECTINSTANCE_HEAD
    {
        public uint dwSize;
        public Guid guidType;
        public uint dwOfs;
        public uint dwType;
        public uint dwFlags;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct DIDEVICEOBJECTINSTANCEW
    {
        public uint dwSize;
        public Guid guidType;
        public uint dwOfs, dwType, dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string tszName;
        public uint dwFFMaxForce, dwFFForceResolution;
        public ushort wCollectionNumber, wDesignatorIndex, wUsagePage, wUsage;
        public uint dwDimension;
        public ushort wExponent, wReportId;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct DIEFFECTINFOW
    {
        public uint dwSize;
        public Guid guid;
        public uint dwEffType, dwStaticParams, dwDynamicParams;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string tszName;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct DIDEVCAPS
    {
        public uint dwSize, dwFlags, dwDevType, dwAxes, dwButtons, dwPOVs;
        public uint dwFFSamplePeriod, dwFFMinTimeResolution, dwFirmwareRevision, dwHardwareRevision, dwFFDriverVersion;
    }

    /** DIPROPHEADER + dwData */
    [StructLayout(LayoutKind.Sequential)]
    struct DIPROPDWORD
    {
        public uint dwSize, dwHeaderSize, dwObj, dwHow, dwData;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct DIEFFECT
    {
        public uint dwSize, dwFlags, dwDuration, dwSamplePeriod, dwGain, dwTriggerButton, dwTriggerRepeatInterval, cAxes;
        public IntPtr rgdwAxes, rglDirection, lpEnvelope;
        public uint cbTypeSpecificParams;
        public IntPtr lpvTypeSpecificParams;
        public uint dwStartDelay;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam, lParam;
        public uint time;
        public int ptX, ptY;
    }

    [DllImport("dinput8.dll")] static extern int DirectInput8Create(IntPtr hinst, int version, ref Guid riid, out IntPtr ppv, IntPtr outer);
    [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandleW(IntPtr name);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr CreateWindowExW(uint exStyle, string cls, string name, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr param);
    [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool PeekMessageW(out MSG msg, IntPtr hwnd, uint min, uint max, uint remove);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG msg);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessageW(ref MSG msg);
    [DllImport("winmm.dll")] static extern uint timeBeginPeriod(uint ms);
    [DllImport("winmm.dll")] static extern uint timeEndPeriod(uint ms);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int EnumDevicesCb(IntPtr lpddi, IntPtr pvRef);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int EnumObjectsCb(IntPtr lpddoi, IntPtr pvRef);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate uint ReleaseFn(IntPtr self);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int CreateDeviceFn(IntPtr self, ref Guid guid, out IntPtr device, IntPtr outer);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int EnumDevicesFn(IntPtr self, uint devType, EnumDevicesCb cb, IntPtr pvRef, uint flags);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetCapabilitiesFn(IntPtr self, ref DIDEVCAPS caps);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int EnumObjectsFn(IntPtr self, EnumObjectsCb cb, IntPtr pvRef, uint flags);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int SetPropertyFn(IntPtr self, IntPtr prop, ref DIPROPDWORD value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int NoArgsFn(IntPtr self);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int PtrArgFn(IntPtr self, IntPtr arg);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int SetCooperativeLevelFn(IntPtr self, IntPtr hwnd, uint flags);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int CreateEffectFn(IntPtr self, ref Guid guid, ref DIEFFECT eff, out IntPtr effect, IntPtr outer);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int UIntArgFn(IntPtr self, uint value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetEffectInfoFn(IntPtr self, ref DIEFFECTINFOW info, ref Guid guid);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int SetParametersFn(IntPtr self, ref DIEFFECT eff, uint flags);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int StartFn(IntPtr self, uint iterations, uint flags);

    static T Method<T>(IntPtr obj, int slot) where T : class
    {
        IntPtr vtbl = Marshal.ReadIntPtr(obj);
        return (T)(object)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(vtbl, slot * IntPtr.Size), typeof(T));
    }

    static void Release(IntPtr obj)
    {
        if (obj != IntPtr.Zero) Method<ReleaseFn>(obj, 2)(obj);
    }

    class DiException : Exception
    {
        public readonly int Hr;
        public DiException(string what, int hr) : base(string.Format("{0} failed (0x{1:X8})", what, hr)) { Hr = hr; }
    }

    static void Check(int hr, string what)
    {
        if (hr < 0) throw new DiException(what, hr);
    }

    class DeviceInfo
    {
        public Guid Instance;
        public string Name;
        public string Product;
        public uint DevType;
        public bool IsWheel { get { return (DevType & 0xFF) == DI8DEVTYPE_DRIVING; } }
    }

    // ---- Shared state between the stdin reader and the force loop
    static readonly object Gate = new object();
    static readonly Stopwatch Clock = Stopwatch.StartNew();
    static readonly Queue<double> inSubframes = new Queue<double>();
    static double inForce, inKerb, inAbs;
    static long inStampMs = long.MinValue / 2;
    static long packets;
    static bool testRequested;
    static double testSign = 1;
    static volatile bool quit;

    static int Main(string[] args)
    {
        string deviceFilter = null;
        double max = 1.0;
        int rateHz = 500;
        int direction = 1;
        bool list = false, info = false, dryRun = false;
        for (int i = 0; i < args.Length; i++)
        {
            string a = args[i];
            if (a == "--list") list = true;
            else if (a == "--info") info = true;
            else if (a == "--dry-run") dryRun = true;
            else if (a == "--device" && i + 1 < args.Length) deviceFilter = args[++i];
            else if (a == "--max" && i + 1 < args.Length) max = Clamp(ParseNum(args[++i], 1.0), 0.05, 1.0);
            else if (a == "--rate" && i + 1 < args.Length) rateHz = (int)Clamp(ParseNum(args[++i], 500), 60, 1000);
            else if (a == "--direction" && i + 1 < args.Length) direction = ParseNum(args[++i], 1) != 0 ? 1 : 0;
        }

        Console.CancelKeyPress += delegate(object sender, ConsoleCancelEventArgs e) { e.Cancel = true; quit = true; };

        if (dryRun) return DryRun(rateHz, max);

        IntPtr di = IntPtr.Zero;
        try
        {
            Guid iid = IID_IDirectInput8W;
            Check(DirectInput8Create(GetModuleHandleW(IntPtr.Zero), DIRECTINPUT_VERSION, ref iid, out di, IntPtr.Zero), "DirectInput8Create");
            if (list) return ListDevices(di);
            if (info) return DeviceDetails(di);
            return Drive(di, deviceFilter, max, rateHz, direction);
        }
        catch (Exception e)
        {
            Status(false, null, 0, e.Message);
            return 1;
        }
        finally
        {
            Release(di);
        }
    }

    // ---- --list

    static int ListDevices(IntPtr di)
    {
        List<DeviceInfo> all = Enumerate(di, DIEDFL_ATTACHEDONLY);
        if (all.Count == 0) Console.WriteLine("No game controllers found.");
        foreach (DeviceInfo d in all)
        {
            string ff = "no force feedback";
            IntPtr dev = IntPtr.Zero;
            try
            {
                Guid g = d.Instance;
                Check(Method<CreateDeviceFn>(di, DI_CreateDevice)(di, ref g, out dev, IntPtr.Zero), "CreateDevice");
                DIDEVCAPS caps = new DIDEVCAPS();
                caps.dwSize = (uint)Marshal.SizeOf(typeof(DIDEVCAPS));
                Check(Method<GetCapabilitiesFn>(dev, DEV_GetCapabilities)(dev, ref caps), "GetCapabilities");
                if ((caps.dwFlags & DIDC_FORCEFEEDBACK) != 0) ff = "force feedback, " + FfAxisOffsets(dev).Count + " FF axis";
            }
            catch (Exception e)
            {
                ff = e.Message;
            }
            finally
            {
                Release(dev);
            }
            Console.WriteLine(string.Format("  {0}{1}  ({2})", d.Name, d.IsWheel ? " [wheel]" : "", ff));
        }
        return 0;
    }

    /** --info: each force-feedback device's axes (which take force, in enumeration order) and constant-force support */
    static int DeviceDetails(IntPtr di)
    {
        List<DeviceInfo> ffDevices = Enumerate(di, DIEDFL_ATTACHEDONLY | DIEDFL_FORCEFEEDBACK);
        if (ffDevices.Count == 0) Console.WriteLine("No force-feedback devices found.");
        foreach (DeviceInfo d in ffDevices)
        {
            Console.WriteLine(string.Format("{0}  type 0x{1:X8}", d.Name, d.DevType));
            IntPtr dev = IntPtr.Zero;
            try
            {
                Guid g = d.Instance;
                Check(Method<CreateDeviceFn>(di, DI_CreateDevice)(di, ref g, out dev, IntPtr.Zero), "CreateDevice");
                DIDEVCAPS caps = new DIDEVCAPS();
                caps.dwSize = (uint)Marshal.SizeOf(typeof(DIDEVCAPS));
                Check(Method<GetCapabilitiesFn>(dev, DEV_GetCapabilities)(dev, ref caps), "GetCapabilities");
                Console.WriteLine(string.Format("  caps flags 0x{0:X}, FF sample period {1} us, min time resolution {2} us, FF driver version {3}",
                    caps.dwFlags, caps.dwFFSamplePeriod, caps.dwFFMinTimeResolution, caps.dwFFDriverVersion));
                EnumObjectsCb cb = delegate(IntPtr p, IntPtr r)
                {
                    DIDEVICEOBJECTINSTANCEW o = (DIDEVICEOBJECTINSTANCEW)Marshal.PtrToStructure(p, typeof(DIDEVICEOBJECTINSTANCEW));
                    int axis = Array.IndexOf(AXIS_GUIDS, o.guidType);
                    Console.WriteLine(string.Format("  axis \"{0}\" ({1}){2}{3}", o.tszName,
                        axis >= 0 ? AXIS_NAMES[axis] : "other",
                        (o.dwFlags & DIDOI_FFACTUATOR) != 0 ? "  FORCE" : "",
                        (o.dwFlags & DIDOI_FFACTUATOR) != 0 ? string.Format(" (max force {0}, resolution {1})", o.dwFFMaxForce, o.dwFFForceResolution) : ""));
                    return 1;
                };
                Check(Method<EnumObjectsFn>(dev, DEV_EnumObjects)(dev, cb, IntPtr.Zero, DIDFT_AXIS), "EnumObjects");
                GC.KeepAlive(cb);
                List<uint> ff = FfAxisOffsets(dev);
                List<string> names = new List<string>();
                foreach (uint o in ff) names.Add(AXIS_NAMES[o / 4]);
                Console.WriteLine("  force axes in order: " + string.Join(", ", names.ToArray()) + "; the bridge drives " + (ff.Count > 0 ? AXIS_NAMES[PickSteeringAxis(ff) / 4] : "none"));
                DIEFFECTINFOW ei = new DIEFFECTINFOW();
                ei.dwSize = (uint)Marshal.SizeOf(typeof(DIEFFECTINFOW));
                Guid cf = GUID_ConstantForce;
                int hr = Method<GetEffectInfoFn>(dev, DEV_GetEffectInfo)(dev, ref ei, ref cf);
                Console.WriteLine(hr < 0
                    ? string.Format("  constant force: not supported (0x{0:X8})", hr)
                    : string.Format("  constant force: \"{0}\", type 0x{1:X}, static params 0x{2:X}, dynamic params 0x{3:X}", ei.tszName, ei.dwEffType, ei.dwStaticParams, ei.dwDynamicParams));
            }
            catch (Exception e)
            {
                Console.WriteLine("  " + e.Message);
            }
            finally
            {
                Release(dev);
            }
        }
        return 0;
    }

    static List<DeviceInfo> Enumerate(IntPtr di, uint flags)
    {
        List<DeviceInfo> found = new List<DeviceInfo>();
        EnumDevicesCb cb = delegate(IntPtr p, IntPtr r)
        {
            DIDEVICEINSTANCEW d = (DIDEVICEINSTANCEW)Marshal.PtrToStructure(p, typeof(DIDEVICEINSTANCEW));
            DeviceInfo info = new DeviceInfo();
            info.Instance = d.guidInstance;
            info.Name = d.tszInstanceName;
            info.Product = d.tszProductName;
            info.DevType = d.dwDevType;
            found.Add(info);
            return 1; // DIENUM_CONTINUE
        };
        int hr = Method<EnumDevicesFn>(di, DI_EnumDevices)(di, DI8DEVCLASS_GAMECTRL, cb, IntPtr.Zero, flags);
        GC.KeepAlive(cb);
        Check(hr, "EnumDevices");
        return found;
    }

    /** The steering axis among the force axes: X when it takes force (where wheels put steering), else the first */
    static uint PickSteeringAxis(List<uint> ffAxes)
    {
        return ffAxes.Contains(0u) ? 0u : ffAxes[0];
    }

    /** c_dfDIJoystick offsets of the device's force-feedback actuator axes (as SDL maps them) */
    static List<uint> FfAxisOffsets(IntPtr dev)
    {
        List<uint> offsets = new List<uint>();
        EnumObjectsCb cb = delegate(IntPtr p, IntPtr r)
        {
            DIDEVICEOBJECTINSTANCE_HEAD o = (DIDEVICEOBJECTINSTANCE_HEAD)Marshal.PtrToStructure(p, typeof(DIDEVICEOBJECTINSTANCE_HEAD));
            if ((o.dwType & DIDFT_AXIS) != 0 && (o.dwFlags & DIDOI_FFACTUATOR) != 0)
            {
                int i = Array.IndexOf(AXIS_GUIDS, o.guidType);
                if (i >= 0 && !offsets.Contains((uint)(i * 4))) offsets.Add((uint)(i * 4));
            }
            return 1;
        };
        int hr = Method<EnumObjectsFn>(dev, DEV_EnumObjects)(dev, cb, IntPtr.Zero, DIDFT_AXIS);
        GC.KeepAlive(cb);
        Check(hr, "EnumObjects");
        return offsets;
    }

    // ---- Driving the wheel

    static int Drive(IntPtr di, string deviceFilter, double max, int rateHz, int direction)
    {
        List<DeviceInfo> ffDevices = Enumerate(di, DIEDFL_ATTACHEDONLY | DIEDFL_FORCEFEEDBACK);
        DeviceInfo pick = null;
        foreach (DeviceInfo d in ffDevices)
        {
            bool match = deviceFilter == null ||
                d.Name.IndexOf(deviceFilter, StringComparison.OrdinalIgnoreCase) >= 0 ||
                d.Product.IndexOf(deviceFilter, StringComparison.OrdinalIgnoreCase) >= 0;
            if (!match) continue;
            if (pick == null || (d.IsWheel && !pick.IsWheel)) pick = d;
        }
        if (pick == null)
        {
            Status(false, null, 0, deviceFilter == null
                ? "No force-feedback wheel found (is it switched on and plugged in?)"
                : "No force-feedback device matches \"" + deviceFilter + "\" (run with --list)");
            return 2;
        }
        if (ffDevices.Count > 1)
        {
            List<string> names = new List<string>();
            foreach (DeviceInfo d in ffDevices) names.Add(d.Name);
            Log("Force-feedback devices: " + string.Join(", ", names.ToArray()) + ". Using " + pick.Name + " (pick another with --device).");
        }

        // Top-level WS_POPUP window (never HWND_MESSAGE, which DirectInput8 FFB drivers reject on SetCooperativeLevel)
        IntPtr hwnd = CreateWindowExW(0, "STATIC", "FfbHelper", WS_POPUP, 0, 0, 1, 1, IntPtr.Zero, IntPtr.Zero, GetModuleHandleW(IntPtr.Zero), IntPtr.Zero);
        IntPtr dev = IntPtr.Zero, effect = IntPtr.Zero, format = IntPtr.Zero;
        IntPtr axes = Marshal.AllocHGlobal(4), dir = Marshal.AllocHGlobal(4), constant = Marshal.AllocHGlobal(4);
        timeBeginPeriod(1);
        try
        {
            Guid g = pick.Instance;
            Check(Method<CreateDeviceFn>(di, DI_CreateDevice)(di, ref g, out dev, IntPtr.Zero), "CreateDevice");
            format = BuildJoystickFormat();
            Check(Method<PtrArgFn>(dev, DEV_SetDataFormat)(dev, format), "SetDataFormat");
            Check(Method<SetCooperativeLevelFn>(dev, DEV_SetCooperativeLevel)(dev, hwnd, DISCL_EXCLUSIVE | DISCL_BACKGROUND), "SetCooperativeLevel");
            List<uint> ffAxes = FfAxisOffsets(dev);
            if (ffAxes.Count == 0) throw new Exception(pick.Name + " reports no force-feedback axis");

            SetDword(dev, DIPROP_AUTOCENTER, 0);
            int hr = Method<NoArgsFn>(dev, DEV_Acquire)(dev);
            if (hr == DIERR_OTHERAPPHASPRIO) throw new Exception("Another program has the wheel's force feedback (close the other sim, then restart the bridge)");
            Check(hr, "Acquire");
            Method<UIntArgFn>(dev, DEV_SendForceFeedbackCommand)(dev, DISFFC_RESET);
            Method<UIntArgFn>(dev, DEV_SendForceFeedbackCommand)(dev, DISFFC_SETACTUATORSON);
            // The reset restores the driver's defaults: the centring spring goes off again, full device gain
            SetDword(dev, DIPROP_AUTOCENTER, 0);
            SetDword(dev, DIPROP_FFGAIN, DI_FFNOMINALMAX);

            // One constant force on the steering axis; with a single axis the magnitude's sign is the direction
            Marshal.WriteInt32(axes, (int)PickSteeringAxis(ffAxes));
            Marshal.WriteInt32(dir, direction);
            Marshal.WriteInt32(constant, 0);
            DIEFFECT eff = new DIEFFECT();
            eff.dwSize = (uint)Marshal.SizeOf(typeof(DIEFFECT));
            eff.dwFlags = DIEFF_CARTESIAN | DIEFF_OBJECTOFFSETS;
            eff.dwDuration = INFINITE;
            eff.dwGain = DI_FFNOMINALMAX;
            eff.dwTriggerButton = DIEB_NOTRIGGER;
            eff.cAxes = 1;
            eff.rgdwAxes = axes;
            eff.rglDirection = dir;
            eff.cbTypeSpecificParams = 4; // DICONSTANTFORCE
            eff.lpvTypeSpecificParams = constant;
            Guid cf = GUID_ConstantForce;
            Check(Method<CreateEffectFn>(dev, DEV_CreateEffect)(dev, ref cf, ref eff, out effect, IntPtr.Zero), "CreateEffect (constant force)");
            Check(Method<StartFn>(effect, EFF_Start)(effect, 1, 0), "Start effect");

            Status(true, pick.Name, ffAxes.Count, null);
            Log(string.Format(CultureInfo.InvariantCulture, "Driving {0} at {1} Hz, output cap {2:0}%. Ctrl+C to stop.", pick.Name, rateHz, max * 100));

            Thread reader = new Thread(ReadInput);
            reader.IsBackground = true;
            reader.Start();

            SetParametersFn setParameters = Method<SetParametersFn>(effect, EFF_SetParameters);
            NoArgsFn acquire = Method<NoArgsFn>(dev, DEV_Acquire);
            NoArgsFn poll = Method<NoArgsFn>(dev, DEV_Poll);
            StartFn start = Method<StartFn>(effect, EFF_Start);
            ForceShaper shaper = new ForceShaper(rateHz, max);
            int lastMagnitude = 0;
            bool lost = false;
            long retryAtMs = 0;
            RunLoop(rateHz, delegate(double tSec)
            {
                PumpMessages(hwnd);
                int magnitude = (int)Math.Round(shaper.Next(tSec) * DI_FFNOMINALMAX);
                if (lost)
                {
                    if (Clock.ElapsedMilliseconds < retryAtMs) return;
                    retryAtMs = Clock.ElapsedMilliseconds + 500;
                    if (acquire(dev) < 0 || start(effect, 1, 0) < 0) return;
                    lost = false;
                    lastMagnitude = int.MinValue;
                    Status(true, pick.Name, ffAxes.Count, null);
                }
                poll(dev);
                if (magnitude == lastMagnitude) return;
                Marshal.WriteInt32(constant, magnitude);
                // Magnitude only: DIEP_START here would restart the effect on every update (at the loop rate); the
                // effect is started once at creation and again after a re-acquire
                if (setParameters(effect, ref eff, DIEP_TYPESPECIFICPARAMS) < 0)
                {
                    lost = true;
                    retryAtMs = Clock.ElapsedMilliseconds + 500;
                    Status(false, pick.Name, ffAxes.Count, "Lost the wheel (unplugged, or another program took its force feedback); retrying");
                    return;
                }
                lastMagnitude = magnitude;
            });

            // Back to no force before letting go
            Marshal.WriteInt32(constant, 0);
            setParameters(effect, ref eff, DIEP_TYPESPECIFICPARAMS);
            return 0;
        }
        catch (Exception e)
        {
            Status(false, pick.Name, 0, e.Message);
            return 1;
        }
        finally
        {
            if (effect != IntPtr.Zero)
            {
                Method<NoArgsFn>(effect, EFF_Stop)(effect);
                Method<NoArgsFn>(effect, EFF_Unload)(effect);
                Release(effect);
            }
            if (dev != IntPtr.Zero)
            {
                Method<NoArgsFn>(dev, DEV_Unacquire)(dev);
                Release(dev);
            }
            timeEndPeriod(1);
            if (hwnd != IntPtr.Zero) DestroyWindow(hwnd);
            Marshal.FreeHGlobal(axes);
            Marshal.FreeHGlobal(dir);
            Marshal.FreeHGlobal(constant);
            // format (and its GUIDs) stays allocated: the device may still reference it until the process ends
        }
    }

    static int DryRun(int rateHz, double max)
    {
        Status(true, "dry run (no wheel)", 1, null);
        Log("Dry run: logging the force once a second instead of driving a wheel.");
        Thread reader = new Thread(ReadInput);
        reader.IsBackground = true;
        reader.Start();
        ForceShaper shaper = new ForceShaper(rateHz, max);
        double peak = 0, nextLog = 1;
        long lastPackets = 0;
        RunLoop(rateHz, delegate(double tSec)
        {
            double f = shaper.Next(tSec);
            peak = Math.Max(peak, Math.Abs(f));
            if (tSec < nextLog) return;
            nextLog = tSec + 1;
            long p;
            lock (Gate) p = packets;
            Log(string.Format(CultureInfo.InvariantCulture, "{0} packets/s, force {1:+0.000;-0.000}, peak {2:0.000}", p - lastPackets, f, peak));
            lastPackets = p;
            peak = 0;
        });
        return 0;
    }

    /** Calls tick(seconds) at rateHz until quit (1 ms timer resolution, spin for the last stretch) */
    static void RunLoop(int rateHz, Action<double> tick)
    {
        long period = Stopwatch.Frequency / rateHz;
        long next = Clock.ElapsedTicks;
        long twoMs = Stopwatch.Frequency / 500;
        while (!quit)
        {
            tick(Clock.Elapsed.TotalSeconds);
            next += period;
            long now = Clock.ElapsedTicks;
            if (now - next > period * 10) next = now; // stalled (debugger, sleep): don't race to catch up
            while (true)
            {
                long remaining = next - Clock.ElapsedTicks;
                if (remaining <= 0) break;
                if (remaining > twoMs) Thread.Sleep(1);
                else Thread.Yield();
            }
        }
    }

    /** Frame-rate packets + 240/480 Hz physics subframes → smooth, capped, slew-limited output */
    class ForceShaper
    {
        readonly double dt, max, smoothK;
        double smoothed, output, testStart = -1, sign = 1, testPeak;

        public ForceShaper(int rateHz, double max)
        {
            dt = 1.0 / rateHz;
            this.max = max;
            smoothK = 1 - Math.Exp(-dt / SMOOTH_TAU_S);
        }

        public double Next(double t)
        {
            double target, kerb, abs;
            bool test;
            long age;
            lock (Gate)
            {
                target = inSubframes.Count > 0 ? inSubframes.Dequeue() : inForce;
                kerb = inKerb;
                abs = inAbs;
                age = Clock.ElapsedMilliseconds - inStampMs;
                test = testRequested;
                testRequested = false;
                if (test) sign = testSign;
            }
            if (age > WATCHDOG_MS) target = kerb = abs = 0;
            if (test)
            {
                testStart = t;
                testPeak = 0;
                Log(sign > 0 ? "Direction test: pulling right, then left" : "Direction test (inverted): pulling left, then right");
            }

            smoothed += (target - smoothed) * smoothK;
            double f = smoothed;
            if (kerb > 0) f += kerb * KERB_AMPLITUDE * Math.Sin(2 * Math.PI * KERB_HZ * t);
            if (abs > 0) f += abs * ABS_AMPLITUDE * (Math.Sin(2 * Math.PI * ABS_HZ * t) >= 0 ? 1 : -1);
            if (testStart >= 0)
            {
                double u = t - testStart;
                double second = TEST_PULL_S + TEST_GAP_S;
                if (u < TEST_PULL_S) f = sign * TEST_LEVEL * Pull(u / TEST_PULL_S);
                else if (u < second) f = 0;
                else if (u < second + TEST_PULL_S) f = -sign * TEST_LEVEL * Pull((u - second) / TEST_PULL_S);
                else
                {
                    testStart = -1;
                    Log(string.Format(CultureInfo.InvariantCulture, "Direction test done: sent up to {0:0}% force to the wheel", testPeak * 100));
                }
            }
            f = Clamp(f, -max, max);
            double step = SLEW_PER_S * dt;
            output += Clamp(f - output, -step, step);
            if (testStart >= 0) testPeak = Math.Max(testPeak, Math.Abs(output));
            return output;
        }

        /** 0 → 1 → 0 over x = 0..1 with a held top: eased in and out, never a jolt */
        static double Pull(double x)
        {
            return SmoothStep(0, 0.2, x) * (1 - SmoothStep(0.8, 1, x));
        }

        static double SmoothStep(double e0, double e1, double x)
        {
            double k = Clamp((x - e0) / (e1 - e0), 0, 1);
            return k * k * (3 - 2 * k);
        }
    }

    static void ReadInput()
    {
        try
        {
            string line;
            while (!quit && (line = Console.In.ReadLine()) != null)
            {
                if (line.Length == 0) continue;
                char c = line[0];
                if (c == 'F')
                {
                    string[] parts = line.Split(' ');
                    double f = parts.Length > 1 ? ParseNum(parts[1], 0) : 0;
                    double k = parts.Length > 2 ? ParseNum(parts[2], 0) : 0;
                    double a = parts.Length > 3 ? ParseNum(parts[3], 0) : 0;
                    lock (Gate)
                    {
                        inForce = Clamp(f, -1.5, 1.5);
                        inKerb = Clamp(k, 0, 1);
                        inAbs = Clamp(a, 0, 1);
                        inSubframes.Clear();
                        for (int i = 4; i < parts.Length; i++)
                        {
                            inSubframes.Enqueue(Clamp(ParseNum(parts[i], f), -1.5, 1.5));
                        }
                        inStampMs = Clock.ElapsedMilliseconds;
                        packets++;
                    }
                }
                else if (c == 'T')
                {
                    string[] parts = line.Split(' ');
                    double s = parts.Length > 1 ? ParseNum(parts[1], 1) : 1;
                    lock (Gate)
                    {
                        testSign = s < 0 ? -1 : 1;
                        testRequested = true;
                    }
                }
                else if (c == 'Z')
                {
                    lock (Gate)
                    {
                        inForce = inKerb = inAbs = 0;
                        inSubframes.Clear();
                        inStampMs = long.MinValue / 2;
                    }
                }
                else if (c == 'Q') break;
            }
        }
        catch (Exception)
        {
            // stdin gone: the bridge exited
        }
        quit = true;
    }

    // ---- Helpers

    /** c_dfDIJoystick (DIJOYSTATE, 80 bytes): 6 axes, 2 sliders, 4 POVs, 32 buttons, all optional */
    static IntPtr BuildJoystickFormat()
    {
        Guid[] guids = { GUID_XAxis, GUID_YAxis, GUID_ZAxis, GUID_RxAxis, GUID_RyAxis, GUID_RzAxis, GUID_Slider, GUID_POV };
        IntPtr guidMem = Marshal.AllocHGlobal(16 * guids.Length);
        for (int i = 0; i < guids.Length; i++) Marshal.Copy(guids[i].ToByteArray(), 0, guidMem + 16 * i, 16);

        int p = IntPtr.Size;
        int objSize = p == 8 ? 24 : 16; // DIOBJECTDATAFORMAT
        const int count = 6 + 2 + 4 + 32;
        IntPtr objs = Marshal.AllocHGlobal(objSize * count);
        int k = 0;
        uint axis = DIDFT_OPTIONAL | DIDFT_AXIS | DIDFT_ANYINSTANCE;
        for (int a = 0; a < 6; a++) WriteObject(objs, objSize, k++, guidMem + 16 * a, 4 * a, axis);
        for (int s = 0; s < 2; s++) WriteObject(objs, objSize, k++, guidMem + 16 * 6, 24 + 4 * s, axis);
        for (int v = 0; v < 4; v++) WriteObject(objs, objSize, k++, guidMem + 16 * 7, 32 + 4 * v, DIDFT_OPTIONAL | DIDFT_POV | DIDFT_ANYINSTANCE);
        for (int b = 0; b < 32; b++) WriteObject(objs, objSize, k++, IntPtr.Zero, 48 + b, DIDFT_OPTIONAL | DIDFT_BUTTON | DIDFT_ANYINSTANCE);

        int fmtSize = p == 8 ? 32 : 24; // DIDATAFORMAT
        IntPtr fmt = Marshal.AllocHGlobal(fmtSize);
        Marshal.WriteInt32(fmt, 0, fmtSize);
        Marshal.WriteInt32(fmt, 4, objSize);
        Marshal.WriteInt32(fmt, 8, DIDF_ABSAXIS);
        Marshal.WriteInt32(fmt, 12, 80);
        Marshal.WriteInt32(fmt, 16, count);
        Marshal.WriteIntPtr(fmt, p == 8 ? 24 : 20, objs);
        return fmt;
    }

    static void WriteObject(IntPtr objs, int objSize, int index, IntPtr guid, int offset, uint type)
    {
        IntPtr o = objs + objSize * index;
        Marshal.WriteIntPtr(o, 0, guid);
        Marshal.WriteInt32(o, IntPtr.Size, offset);
        Marshal.WriteInt32(o, IntPtr.Size + 4, unchecked((int)type));
        Marshal.WriteInt32(o, IntPtr.Size + 8, 0);
    }

    static void SetDword(IntPtr dev, int prop, uint value)
    {
        DIPROPDWORD d = new DIPROPDWORD();
        d.dwSize = (uint)Marshal.SizeOf(typeof(DIPROPDWORD));
        d.dwHeaderSize = 16;
        d.dwObj = 0;
        d.dwHow = 0; // DIPH_DEVICE
        d.dwData = value;
        int hr = Method<SetPropertyFn>(dev, DEV_SetProperty)(dev, new IntPtr(prop), ref d);
        if (hr < 0) Log(string.Format("The wheel refused SetProperty({0}) (0x{1:X8}); carrying on", prop == DIPROP_AUTOCENTER ? "autocentre" : "gain", hr));
    }

    static void PumpMessages(IntPtr hwnd)
    {
        MSG msg;
        while (PeekMessageW(out msg, IntPtr.Zero, 0, 0, 1)) // PM_REMOVE
        {
            TranslateMessage(ref msg);
            DispatchMessageW(ref msg);
        }
    }

    static double ParseNum(string s, double fallback)
    {
        double v;
        return double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out v) && !double.IsNaN(v) && !double.IsInfinity(v) ? v : fallback;
    }

    static double Clamp(double v, double lo, double hi)
    {
        return v < lo ? lo : v > hi ? hi : v;
    }

    static readonly object Out = new object();

    static void Log(string text)
    {
        lock (Out)
        {
            Console.Out.WriteLine("LOG " + text);
            Console.Out.Flush();
        }
    }

    static void Status(bool ok, string device, int axes, string error)
    {
        StringBuilder sb = new StringBuilder("{\"ok\":");
        sb.Append(ok ? "true" : "false");
        sb.Append(",\"device\":").Append(device == null ? "null" : Json(device));
        sb.Append(",\"axes\":").Append(axes);
        sb.Append(",\"error\":").Append(error == null ? "null" : Json(error));
        sb.Append('}');
        lock (Out)
        {
            Console.Out.WriteLine("STATUS " + sb);
            Console.Out.Flush();
        }
    }

    static string Json(string s)
    {
        StringBuilder sb = new StringBuilder("\"");
        foreach (char c in s)
        {
            if (c == '"' || c == '\\') sb.Append('\\').Append(c);
            else if (c < 0x20) sb.Append(string.Format("\\u{0:x4}", (int)c));
            else sb.Append(c);
        }
        return sb.Append('"').ToString();
    }
}
