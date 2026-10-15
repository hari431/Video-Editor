/**
 * Standalone Filmymoji POC — MP4 / WebM Video Exporter Module
 *
 * Composites 3D character overlay onto background video frames, extracts
 * original audio track from source video element, multiplexes stream via
 * MediaRecorder API, and generates downloadable video blob.
 */

export class FilmymojiVideoExporter {
  constructor(canvasElement, sourceVideoElement) {
    this.canvas = canvasElement;
    this.video = sourceVideoElement;
    this.mediaRecorder = null;
    this.recordedChunks = [];
    this.isRecording = false;
  }

  /**
   * Start frame & audio recording from canvas and source video element audio track.
   */
  startRecording(fps = 30) {
    if (this.isRecording) return;

    this.recordedChunks = [];

    // Capture 30 FPS Canvas Stream
    const canvasStream = this.canvas.captureStream(fps);

    // Extract audio track from source video if available
    let combinedStream = canvasStream;
    try {
      if (this.video && typeof this.video.captureStream === 'function') {
        const videoStream = this.video.captureStream();
        const audioTracks = videoStream.getAudioTracks();
        if (audioTracks && audioTracks.length > 0) {
          combinedStream = new MediaStream([
            ...canvasStream.getVideoTracks(),
            ...audioTracks
          ]);
        }
      } else if (this.video && typeof this.video.mozCaptureStream === 'function') {
        const videoStream = this.video.mozCaptureStream();
        const audioTracks = videoStream.getAudioTracks();
        if (audioTracks && audioTracks.length > 0) {
          combinedStream = new MediaStream([
            ...canvasStream.getVideoTracks(),
            ...audioTracks
          ]);
        }
      }
    } catch (e) {
      console.warn('Audio track capture notice:', e);
    }

    // Select supported codec (Prefer VP9/MP4 where available)
    let options = { mimeType: 'video/webm;codecs=vp9,opus' };
    if (!MediaRecorder.isTypeSupported(options.mimeType)) {
      options = { mimeType: 'video/webm;codecs=vp8,opus' };
      if (!MediaRecorder.isTypeSupported(options.mimeType)) {
        options = { mimeType: 'video/webm' };
      }
    }

    this.mediaRecorder = new MediaRecorder(combinedStream, options);

    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        this.recordedChunks.push(event.data);
      }
    };

    this.mediaRecorder.start(100); // 100ms timeslices
    this.isRecording = true;
  }

  /**
   * Stop recording and resolve exported video Blob.
   */
  stopRecording() {
    return new Promise((resolve, reject) => {
      if (!this.isRecording || !this.mediaRecorder) {
        return reject(new Error('Recorder is not active'));
      }

      this.mediaRecorder.onstop = () => {
        this.isRecording = false;
        const blob = new Blob(this.recordedChunks, { type: this.mediaRecorder.mimeType || 'video/webm' });
        const downloadUrl = URL.createObjectURL(blob);
        resolve({
          blob,
          downloadUrl,
          sizeBytes: blob.size,
          mimeType: blob.type
        });
      };

      this.mediaRecorder.stop();
    });
  }
}
