/** Current-facing nominal wrapper around the neutral ordinary IM normalizer. */

import {
  normalizeOrdinaryImTurn,
  type NormalizedOrdinaryImTurn,
  type OrdinaryImTransportEnvelope,
  type OrdinaryImTurnNormalizationResult,
} from './ordinary-im-turn.js';

export type {
  NormalizedOrdinaryImAttachmentDescriptor as PreparedOrdinaryImAttachmentDescriptor,
  OrdinaryImAttachmentDescriptor,
  OrdinaryImMentionDescriptor,
  OrdinaryImSenderDescriptor,
  OrdinaryImTransportEnvelope,
  OrdinaryImTurnRoute,
} from './ordinary-im-turn.js';

const preparedOrdinaryImTurnBrand: unique symbol = Symbol('PreparedOrdinaryImTurn');

/** Nominal compiler provenance only; the neutral normalized fields are unchanged. */
export interface PreparedOrdinaryImTurn extends NormalizedOrdinaryImTurn {
  readonly [preparedOrdinaryImTurnBrand]: true;
}

export type OrdinaryImTurnPrepareResult =
  | { readonly kind: 'prepared'; readonly turn: PreparedOrdinaryImTurn }
  | Extract<OrdinaryImTurnNormalizationResult, { kind: 'rejected' }>;

export interface CurrentOrdinaryImTurnPreparationPort {
  prepare(input: OrdinaryImTransportEnvelope): OrdinaryImTurnPrepareResult;
}

/** Add Current compiler provenance after neutral validation and normalization. */
export function createCurrentOrdinaryImTurnPreparationPort(): CurrentOrdinaryImTurnPreparationPort {
  return Object.freeze({
    prepare(input: OrdinaryImTransportEnvelope): OrdinaryImTurnPrepareResult {
      const normalized = normalizeOrdinaryImTurn(input);
      if (normalized.kind === 'rejected') return normalized;
      const turn = { ...normalized.turn } as PreparedOrdinaryImTurn;
      Object.defineProperty(turn, preparedOrdinaryImTurnBrand, {
        value: true,
        enumerable: false,
        configurable: false,
        writable: false,
      });
      Object.freeze(turn);
      return Object.freeze({ kind: 'prepared', turn });
    },
  });
}
