using System.Diagnostics;
using System.Runtime.InteropServices;

namespace LearnWithMe.Recorder;

internal sealed class RecorderForm : Form
{
    private readonly Button _selectButton = new() { Text = "Select recording area", AutoSize = true };
    private readonly Button _stopButton = new() { Text = "■ Stop recording", AutoSize = true, Enabled = false };
    private readonly Button _saveButton = new() { Text = "Save recording…", AutoSize = true, Enabled = false };
    private readonly Label _status = new() { AutoSize = true, Text = "Ready — select an area to record." };
    private readonly NotifyIcon _tray;
    private readonly ToolStripMenuItem _stopItem = new("Stop recording") { Enabled = false };
    private readonly ToolStripMenuItem _saveItem = new("Save last recording…") { Enabled = false };
    private Process? _ffmpeg;
    private string? _pendingRecordingPath;
    private bool _recording;
    private bool _closing;

    private const int HotKeyId = 0x4C57;
    private const uint ModNone = 0;
    private const int WmHotKey = 0x0312;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    public RecorderForm()
    {
        Text = "Learn with me — Region Recorder";
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        ClientSize = new Size(360, 118);
        TopMost = true;

        var layout = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            Padding = new Padding(12),
            FlowDirection = FlowDirection.TopDown,
            WrapContents = false
        };
        layout.Controls.Add(_selectButton);
        layout.Controls.Add(_stopButton);
        layout.Controls.Add(_saveButton);
        layout.Controls.Add(_status);
        Controls.Add(layout);
        _selectButton.Click += async (_, _) => await BeginSelectionAndRecordingAsync();
        _stopButton.Click += async (_, _) => await StopRecordingAsync();
        _saveButton.Click += (_, _) => SaveRecordingAs();

        var menu = new ContextMenuStrip();
        menu.Items.Add("Select recording area…", null, async (_, _) => await BeginSelectionAndRecordingAsync());
        menu.Items.Add(_stopItem);
        menu.Items.Add(_saveItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Exit", null, (_, _) => Close());
        _stopItem.Click += async (_, _) => await StopRecordingAsync();
        _saveItem.Click += (_, _) => SaveRecordingAs();
        _tray = new NotifyIcon
        {
            Text = "Learn with me Region Recorder",
            Icon = SystemIcons.Application,
            ContextMenuStrip = menu,
            Visible = true
        };
        _tray.DoubleClick += (_, _) =>
        {
            if (!Visible)
            {
                Show();
                Activate();
            }
        };
        FormClosing += OnFormClosing;
    }

    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        if (!RegisterHotKey(Handle, HotKeyId, ModNone, (uint)Keys.F9))
            _status.Text = "Ready. F9 may be in use; the tray menu still works.";
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WmHotKey && m.WParam.ToInt32() == HotKeyId && _recording)
            _ = StopRecordingAsync();
        base.WndProc(ref m);
    }

    private async Task BeginSelectionAndRecordingAsync()
    {
        if (_recording) return;
        // Never replace the only reference to an unsaved recording.
        if (!string.IsNullOrWhiteSpace(_pendingRecordingPath) && File.Exists(_pendingRecordingPath))
        {
            SaveRecordingAs();
            if (!string.IsNullOrWhiteSpace(_pendingRecordingPath)) return;
        }
        var ffmpeg = ResolveFfmpeg();
        if (ffmpeg is null)
        {
            MessageBox.Show(this,
                "FFmpeg was not found. Install FFmpeg and add ffmpeg.exe to PATH, or set LEARNWITHME_FFMPEG to its full path.",
                "FFmpeg required", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }

        Hide();
        Rectangle? region;
        using (var selector = new RegionSelectionForm())
        {
            var result = selector.ShowDialog();
            region = result == DialogResult.OK ? selector.SelectedScreenRegion : null;
        }

        if (region is null)
        {
            if (!_closing) Show();
            return;
        }

        using (var countdown = new CountdownForm(region.Value))
        {
            countdown.Show();
            for (var seconds = 5; seconds >= 1; seconds--)
            {
                countdown.SetCountdown(seconds);
                await Task.Delay(1000);
            }
        }

        if (_closing) return;
        var outputDirectory = Path.Combine(Path.GetTempPath(), "LearnWithMeRecorder");
        Directory.CreateDirectory(outputDirectory);
        _pendingRecordingPath = Path.Combine(outputDirectory, $"recording-{DateTime.Now:yyyyMMdd-HHmmss}.mp4");
        var startInfo = new ProcessStartInfo
        {
            FileName = ffmpeg,
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardError = true,
            CreateNoWindow = true
        };
        AddArg(startInfo, "-hide_banner");
        AddArg(startInfo, "-loglevel");
        AddArg(startInfo, "error");
        AddArg(startInfo, "-y");
        AddArg(startInfo, "-f");
        AddArg(startInfo, "gdigrab");
        AddArg(startInfo, "-framerate");
        AddArg(startInfo, "30");
        AddArg(startInfo, "-offset_x");
        AddArg(startInfo, region.Value.X.ToString());
        AddArg(startInfo, "-offset_y");
        AddArg(startInfo, region.Value.Y.ToString());
        AddArg(startInfo, "-video_size");
        AddArg(startInfo, $"{region.Value.Width}x{region.Value.Height}");
        AddArg(startInfo, "-i");
        AddArg(startInfo, "desktop");
        AddArg(startInfo, "-an");
        AddArg(startInfo, "-c:v");
        AddArg(startInfo, "libx264");
        AddArg(startInfo, "-preset");
        AddArg(startInfo, "veryfast");
        AddArg(startInfo, "-pix_fmt");
        AddArg(startInfo, "yuv420p");
        AddArg(startInfo, "-movflags");
        AddArg(startInfo, "+faststart");
        AddArg(startInfo, _pendingRecordingPath);

        try
        {
            _ffmpeg = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
            // Always drain stderr so FFmpeg cannot block if it emits diagnostics.
            _ffmpeg.ErrorDataReceived += (_, _) => { };
            if (!_ffmpeg.Start()) throw new InvalidOperationException("FFmpeg did not start.");
            _ffmpeg.BeginErrorReadLine();
            _recording = true;
            _stopItem.Enabled = true;
            _stopButton.Enabled = true;
            _selectButton.Enabled = false;
            _status.Text = "Recording… click Stop recording or press F9.";
            Show();
            WindowState = FormWindowState.Normal;
            TopMost = true;
            Activate();
            _tray.Text = "Recording — F9 stops";
            _tray.ShowBalloonTip(1500, "Recording started", "Press F9 or use the tray menu to stop.", ToolTipIcon.Info);
        }
        catch (Exception ex)
        {
            _recording = false;
            _stopItem.Enabled = false;
            _selectButton.Enabled = true;
            _status.Text = "Could not start FFmpeg.";
            MessageBox.Show(this, ex.Message, "Recorder error", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Show();
        }
    }

    private static void AddArg(ProcessStartInfo startInfo, string value) => startInfo.ArgumentList.Add(value);

    private async Task StopRecordingAsync()
    {
        if (!_recording || _ffmpeg is null) return;
        _stopItem.Enabled = false;
        _stopButton.Enabled = false;
        _status.Text = "Finalizing MP4…";
        var finalizedNormally = false;
        try
        {
            await _ffmpeg.StandardInput.WriteLineAsync("q");
            await _ffmpeg.StandardInput.FlushAsync();
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
            await _ffmpeg.WaitForExitAsync(timeout.Token);
            finalizedNormally = _ffmpeg.ExitCode == 0;
        }
        catch (Exception ex)
        {
            _status.Text = "FFmpeg did not finalize cleanly: " + ex.Message;
            try { if (!_ffmpeg.HasExited) _ffmpeg.Kill(true); } catch { }
            try { await _ffmpeg.WaitForExitAsync(); } catch { }
        }
        finally
        {
            _ffmpeg.Dispose();
            _ffmpeg = null;
            _recording = false;
            _stopButton.Enabled = false;
            _selectButton.Enabled = true;
            _tray.Text = "Learn with me Region Recorder";
        }

        if (!string.IsNullOrWhiteSpace(_pendingRecordingPath) && File.Exists(_pendingRecordingPath) &&
            new FileInfo(_pendingRecordingPath).Length > 0)
        {
            _saveItem.Enabled = true;
            _saveButton.Enabled = true;
            _status.Text = finalizedNormally
                ? "Recording complete — choose where to save the MP4."
                : "A partial recording was recovered. Choose where to save it.";
            _tray.ShowBalloonTip(2000, "Recording complete", "Use the tray menu to save the MP4.", ToolTipIcon.Info);
            Show();
            WindowState = FormWindowState.Normal;
            Activate();
            // Run the native dialog after the stop event has fully unwound.
            // The visible Save button remains available if Windows suppresses it.
            BeginInvoke(new Action(SaveRecordingAs));
        }
        else
        {
            _pendingRecordingPath = null;
            _status.Text = "No recording data was produced. Check that FFmpeg supports gdigrab and can capture this display.";
            Show();
        }
    }

    private void SaveRecordingAs()
    {
        if (string.IsNullOrWhiteSpace(_pendingRecordingPath) || !File.Exists(_pendingRecordingPath)) return;
        using var dialog = new SaveFileDialog
        {
            Title = "Save screen recording",
            Filter = "MP4 video (*.mp4)|*.mp4",
            DefaultExt = "mp4",
            AddExtension = true,
            FileName = $"screen-recording-{DateTime.Now:yyyyMMdd-HHmmss}.mp4",
            OverwritePrompt = true
        };
        if (dialog.ShowDialog(this) != DialogResult.OK)
        {
            _status.Text = "Recording kept temporarily. Use the tray menu to save it later.";
            return;
        }

        try
        {
            File.Copy(_pendingRecordingPath, dialog.FileName, overwrite: true);
            _status.Text = $"Saved: {dialog.FileName}";
            _pendingRecordingPath = null;
            _saveItem.Enabled = false;
            _saveButton.Enabled = false;
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, ex.Message, "Could not save recording", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private static string? ResolveFfmpeg()
    {
        var configured = Environment.GetEnvironmentVariable("LEARNWITHME_FFMPEG");
        if (!string.IsNullOrWhiteSpace(configured) && File.Exists(configured)) return configured;
        var path = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
        foreach (var directory in path.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            var candidate = Path.Combine(directory.Trim('"'), "ffmpeg.exe");
            if (File.Exists(candidate)) return candidate;
        }
        return null;
    }

    private void OnFormClosing(object? sender, FormClosingEventArgs e)
    {
        if (_recording)
        {
            var answer = MessageBox.Show(this, "A recording is in progress. Stop and exit?", "Exit recorder",
                MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
            if (answer != DialogResult.Yes)
            {
                e.Cancel = true;
                return;
            }
            try
            {
                _ffmpeg?.StandardInput.WriteLine("q");
                _ffmpeg?.WaitForExit(5000);
            }
            catch { }
        }

        _closing = true;
        try { UnregisterHotKey(Handle, HotKeyId); } catch { }
        _tray.Visible = false;
        _tray.Dispose();
        _ffmpeg?.Dispose();
    }
}

internal sealed class CountdownForm : Form
{
    private readonly Label _label = new()
    {
        Dock = DockStyle.Fill,
        TextAlign = ContentAlignment.MiddleCenter,
        ForeColor = Color.White,
        BackColor = Color.FromArgb(15, 23, 42),
        Font = new Font("Segoe UI", 30, FontStyle.Bold)
    };

    public CountdownForm(Rectangle region)
    {
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        Bounds = region;
        TopMost = true;
        ShowInTaskbar = false;
        BackColor = Color.FromArgb(15, 23, 42);
        Opacity = 0.82;
        Controls.Add(_label);
    }

    public void SetCountdown(int seconds)
    {
        _label.Text = seconds.ToString();
        _label.Refresh();
    }
}
