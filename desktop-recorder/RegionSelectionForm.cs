namespace LearnWithMe.Recorder;

internal sealed class RegionSelectionForm : Form
{
    private Point _anchor;
    private Rectangle _selection;
    private bool _dragging;

    public Rectangle? SelectedScreenRegion { get; private set; }

    public RegionSelectionForm()
    {
        var bounds = Screen.PrimaryScreen?.Bounds ?? throw new InvalidOperationException("No primary display was found.");
        StartPosition = FormStartPosition.Manual;
        Bounds = bounds;
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        DoubleBuffered = true;
        BackColor = Color.Magenta;
        TransparencyKey = Color.Magenta;
        Opacity = 0.48;
        Cursor = Cursors.Cross;
        KeyPreview = true;
        Text = "Select recording area";
        MouseDown += OnSelectionMouseDown;
        MouseMove += OnSelectionMouseMove;
        MouseUp += OnSelectionMouseUp;
        KeyDown += (_, e) =>
        {
            if (e.KeyCode == Keys.Escape)
            {
                SelectedScreenRegion = null;
                DialogResult = DialogResult.Cancel;
                Close();
            }
        };
    }

    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        Activate();
        Focus();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        using var dim = new SolidBrush(Color.Black);
        e.Graphics.FillRectangle(dim, ClientRectangle);
        if (_selection.Width > 4 && _selection.Height > 4)
        {
            // TransparencyKey makes the selected interior a real hole while
            // the full form still receives mouse input for drag tracking.
            using var clear = new SolidBrush(TransparencyKey);
            e.Graphics.FillRectangle(clear, Rectangle.Inflate(_selection, -2, -2));
            using var pen = new Pen(Color.DeepSkyBlue, 2);
            e.Graphics.DrawRectangle(pen, _selection);
        }
        if (_selection.Width <= 0 || _selection.Height <= 0) return;
        using var font = new Font("Segoe UI", 10, FontStyle.Bold);
        var label = $"{_selection.Width} × {_selection.Height} — release to select";
        var size = e.Graphics.MeasureString(label, font);
        var labelRect = new RectangleF(_selection.Left, Math.Max(0, _selection.Top - size.Height - 8), size.Width + 14, size.Height + 6);
        using var bg = new SolidBrush(Color.FromArgb(235, 15, 23, 42));
        using var fg = new SolidBrush(Color.White);
        e.Graphics.FillRectangle(bg, labelRect);
        e.Graphics.DrawString(label, font, fg, labelRect.Left + 7, labelRect.Top + 3);
    }

    private void OnSelectionMouseDown(object? sender, MouseEventArgs e)
    {
        if (e.Button != MouseButtons.Left) return;
        _anchor = e.Location;
        _selection = new Rectangle(e.X, e.Y, 0, 0);
        _dragging = true;
        Invalidate();
    }

    private void OnSelectionMouseMove(object? sender, MouseEventArgs e)
    {
        if (!_dragging) return;
        _selection = Normalize(_anchor, e.Location);
        Invalidate();
    }

    private void OnSelectionMouseUp(object? sender, MouseEventArgs e)
    {
        if (!_dragging || e.Button != MouseButtons.Left) return;
        _dragging = false;
        _selection = Normalize(_anchor, e.Location);
        if (_selection.Width < 32 || _selection.Height < 32)
        {
            SelectedScreenRegion = null;
            Invalidate();
            return;
        }

        SelectedScreenRegion = new Rectangle(
            Bounds.Left + _selection.Left,
            Bounds.Top + _selection.Top,
            _selection.Width,
            _selection.Height);
        DialogResult = DialogResult.OK;
        Close();
    }

    private static Rectangle Normalize(Point a, Point b) =>
        Rectangle.FromLTRB(Math.Min(a.X, b.X), Math.Min(a.Y, b.Y), Math.Max(a.X, b.X), Math.Max(a.Y, b.Y));
}
