import React from 'react';
import type { AnnotationRecord, SelectionBox } from '@syrinxone/shared';

export interface ContextMenuState {
  x: number;
  y: number;
  rowChannel: number;
  annotation: AnnotationRecord | null;
}

interface SpectrogramContextMenuProps {
  menu: ContextMenuState;
  windowStartSec: number;
  viewStartSec: number;
  viewEndSec: number;
  selection: SelectionBox | null;
  onClose: () => void;
  onPlayRange: (startSec: number, endSec: number, channel: number) => void;
  onUpdateAnnotation: (annId: string, patch: { comment: string }) => void;
  onSetRedefineAnnotationId: (annId: string) => void;
  onSetSelectionForKlip: (sel: SelectionBox) => void;
  onDeleteAnnotation: (annId: string) => void;
  onZoomToSelection: (sel: SelectionBox) => void;
  onLogSelection: () => void;
  onOpenKlipModal: () => void;
  onResetZoom: () => void;
  onAutoGain: (scope: 'selection' | 'view') => void;
  onCopyImage: () => void;
  onExportMatrixTsv: () => void;
  onOpenDetectModal: () => void;
  onStepFile: (delta: -1 | 1) => void;
  onDuplicateWindow: () => void;
}

export const SpectrogramContextMenu: React.FC<SpectrogramContextMenuProps> = ({
  menu,
  windowStartSec,
  viewStartSec,
  viewEndSec,
  selection,
  onClose,
  onPlayRange,
  onUpdateAnnotation,
  onSetRedefineAnnotationId,
  onSetSelectionForKlip,
  onDeleteAnnotation,
  onZoomToSelection,
  onLogSelection,
  onOpenKlipModal,
  onResetZoom,
  onAutoGain,
  onCopyImage,
  onExportMatrixTsv,
  onOpenDetectModal,
  onStepFile,
  onDuplicateWindow,
}) => {
  return (
    <div
      className="context-menu"
      style={{ left: `${menu.x}px`, top: `${menu.y}px` }}
      onClick={(e) => e.stopPropagation()}
    >
      {menu.annotation && (
        <>
          <div className="context-menu-label">
            Annotation: {menu.annotation.comment || '(blank)'}
          </div>
          <button
            onClick={() => {
              const a = menu.annotation!;
              onPlayRange(
                Math.max(0, a.startTimeSec - windowStartSec),
                Math.max(0.05, a.endTimeSec - windowStartSec),
                a.channel ? Math.max(0, a.channel - 1) : menu.rowChannel,
              );
              onClose();
            }}
          >
            Play Selected Annotation
          </button>
          <button
            onClick={() => {
              const a = menu.annotation!;
              const next = window.prompt('Edit annotation comment:', a.comment);
              if (next !== null) onUpdateAnnotation(a.id, { comment: next });
              onClose();
            }}
          >
            Edit Annotation Comment...
          </button>
          <button
            onClick={() => {
              onSetRedefineAnnotationId(menu.annotation!.id);
              onClose();
            }}
          >
            Redefine Box on Next Drag
          </button>
          <button
            onClick={() => {
              const a = menu.annotation!;
              onSetSelectionForKlip({
                startSec: a.startTimeSec,
                endSec: a.endTimeSec,
                lowFreqHz: a.lowFreqHz,
                highFreqHz: a.highFreqHz,
                channel: a.channel,
              });
              onOpenKlipModal();
              onClose();
            }}
          >
            Clip &amp; Save Annotation...
          </button>
          <button
            className="danger"
            onClick={() => {
              onDeleteAnnotation(menu.annotation!.id);
              onClose();
            }}
          >
            Delete Annotation (Del)
          </button>
          <hr />
        </>
      )}

      <button
        onClick={() => {
          if (selection) {
            onPlayRange(
              Math.min(selection.startSec, selection.endSec),
              Math.max(selection.startSec, selection.endSec),
              Math.max(0, selection.channel - 1),
            );
          } else {
            onPlayRange(viewStartSec, viewEndSec, menu.rowChannel);
          }
          onClose();
        }}
      >
        Play Selection / View (P)
      </button>

      {selection && (
        <>
          <button
            onClick={() => {
              onZoomToSelection(selection);
              onClose();
            }}
          >
            Zoom to Selection
          </button>
          <button
            onClick={() => {
              onLogSelection();
              onClose();
            }}
          >
            Log Selection as Annotation (Enter)
          </button>
          <button
            onClick={() => {
              onOpenKlipModal();
              onClose();
            }}
          >
            Clip &amp; Save Selection (Ctrl+K)
          </button>
        </>
      )}

      <button
        onClick={() => {
          onResetZoom();
          onClose();
        }}
      >
        Reset Full View (Ctrl+0)
      </button>
      <button
        onClick={() => {
          onAutoGain(selection ? 'selection' : 'view');
          onClose();
        }}
      >
        {selection ? 'Auto Gain (Selection)' : 'Auto Gain (View)'}
      </button>

      <hr />

      <button
        onClick={() => {
          onCopyImage();
          onClose();
        }}
      >
        Copy Spectrogram Image (PNG)
      </button>
      <button
        onClick={() => {
          onExportMatrixTsv();
          onClose();
        }}
      >
        Export Spectrogram Matrix (.tsv)
      </button>
      <button
        onClick={() => {
          onOpenDetectModal();
          onClose();
        }}
      >
        Detect Sounds in Recording...
      </button>

      <hr />

      <button
        onClick={() => {
          onStepFile(-1);
          onClose();
        }}
      >
        Previous File in Folder (Alt+←)
      </button>
      <button
        onClick={() => {
          onStepFile(1);
          onClose();
        }}
      >
        Next File in Folder (Alt+→)
      </button>
      <button
        onClick={() => {
          onDuplicateWindow();
          onClose();
        }}
      >
        Duplicate Window
      </button>
    </div>
  );
};
