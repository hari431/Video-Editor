import React from 'react';
import {
  AbsoluteFill,
  Audio,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  Video,
} from 'remotion';

// Single POC composition: main video (trimmed) + floating PiP overlay +
// text + audio + watermark. All geometry arrives as frame fractions (0..1)
// from adapter.mjs so preview and render share one source of truth.
export const GuidewirePoc = (props) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const {
    main,
    overlay = null,
    text = null,
    audio = null,
    watermark = null,
  } = props;

  const overlayVisible =
    overlay && frame >= overlay.startFrame && frame <= overlay.endFrame;
  const textVisible =
    text && frame >= text.startFrame && frame <= text.endFrame;

  const wmPos = watermark && typeof watermark.position !== 'undefined' ? watermark.position : 1;
  const wmStyle =
    wmPos === 2
      ? { left: 16, top: 16 }
      : wmPos === 3
        ? { left: '50%', top: '50%', transform: 'translate(-50%,-50%)' }
        : wmPos === 4
          ? { right: 16, top: 16 }
          : wmPos === 5
            ? { left: 16, bottom: 16 }
            : { right: 16, bottom: 16 };

  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      <Sequence from={0} durationInFrames={props.durationInFrames}>
        <Video
          src={staticFile(main.src)}
          trimBefore={main.trimBeforeFrames || 0}
          style={{ width: '100%', height: '100%', objectFit: 'contain' }}
        />
      </Sequence>

      {overlayVisible ? (
        <div
          style={{
            position: 'absolute',
            left: `${overlay.x * 100}%`,
            top: `${overlay.y * 100}%`,
            width: `${overlay.w * 100}%`,
            aspectRatio: '16 / 9',
            overflow: 'hidden',
            borderRadius: 12,
            border: '2px solid white',
          }}
        >
          <Video
            src={staticFile(overlay.src)}
            trimBefore={overlay.trimBeforeFrames || 0}
            muted
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        </div>
      ) : null}

      {audio ? (
        <Sequence from={0} durationInFrames={props.durationInFrames}>
          <Audio src={staticFile(audio.src)} trimBefore={audio.trimBeforeFrames || 0} volume={1} />
        </Sequence>
      ) : null}

      {textVisible ? (
        <div
          style={{
            position: 'absolute',
            left: `${text.x * width}px`,
            top: `${text.y * height}px`,
            fontSize: Math.max(12, Math.round(text.sizeFrac * height)),
            color: text.color || '#FFFFFF',
            fontFamily: 'Arial, sans-serif',
            fontWeight: 700,
            textShadow: '2px 2px 4px rgba(0,0,0,0.8)',
            whiteSpace: 'pre',
          }}
        >
          {text.content}
        </div>
      ) : null}

      {watermark && watermark.text ? (
        <div
          style={{
            position: 'absolute',
            fontSize: Math.max(10, Math.round(0.045 * height)),
            color: '#FFFFFF',
            opacity: 0.75,
            fontFamily: 'Arial, sans-serif',
            textShadow: '2px 2px 2px rgba(0,0,0,0.6)',
            ...wmStyle,
          }}
        >
          {watermark.text}
        </div>
      ) : null}
    </AbsoluteFill>
  );
};
