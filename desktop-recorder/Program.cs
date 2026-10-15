namespace LearnWithMe.Recorder;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        ApplicationConfiguration.Initialize();
        Application.Run(new RecorderForm());
    }
<<<<<<< HEAD

    // Protocol-driven overlay for the browser-based Screen Recorder:
    // `outline <x> <y> <w> <h>` shows the persistent region ring (physical
    // screen pixels, same space as RegionSelectionForm), `outline-hide`
    // removes it. Anything else falls through to the main recorder window.
    private static bool TryRunOutlineCommand(string[] args)
    {
        if (args.Length == 0) return false;

        // The registered URL protocol invokes this executable directly. Convert
        // its single URL argument to the same command shape used by older
        // launch-recorder.ps1 installations, while keeping launch URLs routed
        // to the normal recorder window.
        if (args.Length == 1 && Uri.TryCreate(args[0], UriKind.Absolute, out var uri) &&
            string.Equals(uri.Scheme, "learnwithme-recorder", StringComparison.OrdinalIgnoreCase))
        {
            if (string.Equals(uri.Host, "outline-hide", StringComparison.OrdinalIgnoreCase))
                args = new[] { "outline-hide" };
            else if (string.Equals(uri.Host, "outline", StringComparison.OrdinalIgnoreCase))
            {
                var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                foreach (var pair in uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
                {
                    var parts = pair.Split('=', 2);
                    if (parts.Length == 2)
                        values[Uri.UnescapeDataString(parts[0])] = Uri.UnescapeDataString(parts[1]);
                }
                if (values.TryGetValue("x", out var sx) && values.TryGetValue("y", out var sy) &&
                    values.TryGetValue("w", out var sw) && values.TryGetValue("h", out var sh))
                    args = new[] { "outline", sx, sy, sw, sh };
                else
                    return true; // Ignore malformed advisory outline commands silently.
            }
            else
                return false; // "launch" and unknown URLs open the normal app.
        }

        if (string.Equals(args[0], "outline-hide", StringComparison.OrdinalIgnoreCase))
        {
            OutlineProcess.HideAnyOutline();
            return true;
        }
        if (string.Equals(args[0], "outline", StringComparison.OrdinalIgnoreCase) && args.Length >= 5 &&
            int.TryParse(args[1], out var x) && int.TryParse(args[2], out var y) &&
            int.TryParse(args[3], out var w) && int.TryParse(args[4], out var h) &&
            w >= 16 && h >= 16)
        {
            OutlineProcess.ShowOutline(new Rectangle(x, y, w, h));
            return true;
        }
        return false;
    }
=======
>>>>>>> parent of d24e4f8 (Reapply "Add protocol-driven desktop outline for browser recording region")
}
