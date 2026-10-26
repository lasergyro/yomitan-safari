/*
 * Copyright (C) 2023-2025  Yomitan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import type * as Audio from './audio';
import type * as Settings from './settings';

export type SourceData = Audio.AudioSourceInfo;

export type PlayParams = {
    // Correlates the pop-up's request with the player's `inlineAudioPlayerPlayed` reply.
    id: number;
    term: string;
    reading: string;
    // The ordered audio sources to walk, already resolved by the pop-up (options plus any language
    // defaults); the player plays the first that yields audio.
    sources: SourceData[];
    // The dictionary entry's language ISO code, for source resolution and TTS.
    language: string;
    // Playback volume on the 0–100 scale (the raw `options.audio.volume`).
    volume: number;
    fallbackSoundType: Settings.FallbackSoundType;
    // Test-only (the loopback audio probe): mute the element and report playback evidence in the reply.
    // A gesture-free automated run cannot make audible autoplay succeed, so the probe plays muted and
    // measures the pipeline + the `allow="autoplay"` Permissions-Policy effect instead of sound.
    muted?: boolean;
    probe?: boolean;
};

// Objective, machine-readable evidence that playback actually progressed (or why it did not). Gathered
// by the player after `play()`, over a short sample window, for the loopback audio probe.
export type PlaybackEvidence = {
    // A configured source produced audio (vs falling through to the fallback sound).
    resolved: boolean;
    kind: 'audio' | 'tts' | 'fallback';
    // The `HTMLMediaElement.play()` promise settled without rejecting.
    playPromiseResolved: boolean;
    // The rejection name/text when it did reject — `'NotAllowedError'` is the autoplay block.
    playError: string | null;
    paused: boolean;
    muted: boolean;
    currentTime: number;
    // `currentTime` advanced during the sample window — the element is really playing.
    advanced: boolean;
    duration: number | null;
    readyState: number | null;
    mediaError: number | null;
};

// Host page (pop-up) → player frame.
export type PlayerInboundMessage =
    | {action: 'play', params: PlayParams}
    | {action: 'stop'};

// Player frame → host page (pop-up / probe).
export type PlayerOutboundMessage =
    | {action: 'inlineAudioPlayerBooting'}
    | {action: 'inlineAudioPlayerReady'}
    | {action: 'inlineAudioPlayerError', message: string}
    | {action: 'inlineAudioPlayerPlayed', params: {id: number, played: boolean, evidence: PlaybackEvidence | null}};
