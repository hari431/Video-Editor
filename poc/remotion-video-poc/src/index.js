import React from 'react';
import { Composition, registerRoot } from 'remotion';
import { GuidewirePoc } from './GuidewirePoc.jsx';
import defaultProps from '../edl.input-props.json' with { type: 'json' };

// Entry point for `remotion studio` / bundler only. No app wiring.
export const RemotionRoot = () => {
  return (
    <>
      <Composition
        id="GuidewirePoc"
        component={GuidewirePoc}
        durationInFrames={defaultProps.durationInFrames}
        fps={defaultProps.fps}
        width={defaultProps.width}
        height={defaultProps.height}
        defaultProps={defaultProps}
      />
    </>
  );
};

registerRoot(RemotionRoot);
