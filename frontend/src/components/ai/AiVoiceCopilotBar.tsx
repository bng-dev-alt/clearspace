'use client';

import React, { useState, useEffect, useRef } from 'react';
import { Mic, MicOff, Send, X, Check, Sparkles, AlertCircle } from 'lucide-react';
import { Card, Column, TeamMember } from '../../types/kanban';
import { aiClient } from '../../services/ai/aiClient';

export interface VoiceActionParsed {
  intentType: 'CREATE_CARD' | 'MOVE_CARD' | 'CHANGE_PRIORITY' | 'RENAME_COLUMN' | 'ADD_CHECKLIST' | 'GENERAL_RESPONSE';
  summary: string;
  actionPayload: {
    cardTitle?: string;
    columnName?: string;
    targetColumnName?: string;
    priority?: 'Low' | 'Medium' | 'High';
    assigneeName?: string;
    details?: string;
    checklistItems?: string[];
  };
}

interface AiVoiceCopilotBarProps {
  isOpen: boolean;
  onClose: () => void;
  columns: Column[];
  members?: TeamMember[];
  projectName: string;
  onAddCard: (columnId: string, cardData: { title: string; details: string; priority?: 'Low' | 'Medium' | 'High' }) => void;
  onMoveCard: (cardId: string, fromColumnId: string, toColumnId: string) => void;
  onUpdateCard: (columnId: string, cardId: string, updates: Partial<Card>) => void;
  onAddChecklistItem: (columnId: string, cardId: string, text: string) => void;
  onRenameColumn: (columnId: string, newName: string) => void;
}

export default function AiVoiceCopilotBar({
  isOpen,
  onClose,
  columns,
  members: _members = [],
  projectName: _projectName,
  onAddCard,
  onMoveCard,
  onUpdateCard,
  onAddChecklistItem,
  onRenameColumn,
}: AiVoiceCopilotBarProps) {
  const [transcript, setTranscript] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [parsedAction, setParsedAction] = useState<VoiceActionParsed | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  const startRecording = async () => {
    setError(null);
    setParsedAction(null);
    audioChunksRef.current = [];

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        const audioBlob = new Blob(audioChunksRef.current, { type: mediaRecorder.mimeType || 'audio/webm' });
        await handleAudioUpload(audioBlob, mediaRecorder.mimeType || 'audio/webm');
      };

      mediaRecorder.start();
      mediaRecorderRef.current = mediaRecorder;
      setIsRecording(true);
    } catch (err) {
      setError('Nepodařilo se přistoupit k mikrofonu: ' + (err instanceof Error ? err.message : 'Povolte přístup k mikrofonu'));
      setIsRecording(false);
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        mediaRecorderRef.current.stop();
      } catch {}
    }
    setIsRecording(false);
  };

  // Zavření panelu ukončí nahrávání a uklidí stav. Efekt je až za
  // `stopRecording`, aby se na něj neodkazoval před deklarací.
  useEffect(() => {
    if (!isOpen) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      stopRecording();
      setTranscript('');
      setParsedAction(null);
      setError(null);
    }
  }, [isOpen]);

  const toggleRecording = () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  };

  const handleAudioUpload = async (blob: Blob, mimeType: string) => {
    setIsLoading(true);
    setError(null);

    try {
      const reader = new FileReader();
      reader.readAsDataURL(blob);
      reader.onloadend = async () => {
        const base64Data = (reader.result as string).split(',')[1];
        await sendVoicePayload({ audioBase64: base64Data, mimeType });
      };
    } catch {
      setError('Chyba při zpracování zvuku.');
      setIsLoading(false);
    }
  };

  const sendVoicePayload = async (payload: { transcript?: string; audioBase64?: string; mimeType?: string }) => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await aiClient.fetchAi('/api/ai/voice-action', 'Gemini Multimodal Voice Action', {
        ...payload,
      });

      if (response && response.parsed) {
        setParsedAction(response.parsed as VoiceActionParsed);
      } else {
        throw new Error('Nepodařilo se přeložit hlasový příkaz na akční záměr.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Chyba při zpracování příkazu.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleProcessTranscript = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!transcript.trim() || isLoading) return;
    stopRecording();
    await sendVoicePayload({ transcript: transcript.trim() });
  };

  const handleExecuteAction = () => {
    if (!parsedAction) return;

    const { intentType, actionPayload } = parsedAction;

    try {
      if (intentType === 'CREATE_CARD' && actionPayload.cardTitle) {
        let col = columns.find((c) => c.name.toLowerCase() === actionPayload.columnName?.toLowerCase());
        if (!col && columns.length > 0) col = columns[0];

        if (col) {
          onAddCard(col.id, {
            title: actionPayload.cardTitle,
            details: actionPayload.details || 'Vytvořeno přes AI Voice Copilot',
            priority: actionPayload.priority || 'Medium',
          });
        }
      } else if (intentType === 'MOVE_CARD' && actionPayload.cardTitle && actionPayload.columnName) {
        const targetCol = columns.find((c) => c.name.toLowerCase() === actionPayload.columnName?.toLowerCase());
        const sourceCol = columns.find((c) => c.cards.some((card) => card.title.toLowerCase().includes(actionPayload.cardTitle!.toLowerCase())));
        const card = sourceCol?.cards.find((c) => c.title.toLowerCase().includes(actionPayload.cardTitle!.toLowerCase()));

        if (targetCol && sourceCol && card) {
          onMoveCard(card.id, sourceCol.id, targetCol.id);
        }
      } else if (intentType === 'CHANGE_PRIORITY' && actionPayload.cardTitle && actionPayload.priority) {
        const sourceCol = columns.find((c) => c.cards.some((card) => card.title.toLowerCase().includes(actionPayload.cardTitle!.toLowerCase())));
        const card = sourceCol?.cards.find((c) => c.title.toLowerCase().includes(actionPayload.cardTitle!.toLowerCase()));

        if (sourceCol && card) {
          onUpdateCard(sourceCol.id, card.id, { priority: actionPayload.priority });
        }
      } else if (intentType === 'RENAME_COLUMN' && actionPayload.columnName && actionPayload.targetColumnName) {
        const col = columns.find((c) => c.name.toLowerCase() === actionPayload.columnName?.toLowerCase());
        if (col) {
          onRenameColumn(col.id, actionPayload.targetColumnName);
        }
      } else if (intentType === 'ADD_CHECKLIST' && actionPayload.cardTitle && actionPayload.checklistItems) {
        const sourceCol = columns.find((c) => c.cards.some((card) => card.title.toLowerCase().includes(actionPayload.cardTitle!.toLowerCase())));
        const card = sourceCol?.cards.find((c) => c.title.toLowerCase().includes(actionPayload.cardTitle!.toLowerCase()));

        if (sourceCol && card) {
          actionPayload.checklistItems.forEach((itemText) => {
            onAddChecklistItem(sourceCol!.id, card!.id, itemText);
          });
        }
      }

      onClose();
    } catch {
      setError('Akci na boardu se nepodařilo dokončit. Zkontrolujte board a zkuste to prosím znovu.');
    }
  };

  if (!isOpen) return null;

  return (
    <div
      style={{
        position: 'fixed',
        bottom: '1.5rem',
        left: '50%',
        transform: 'translateX(-50%)',
        maxWidth: '750px',
        width: '92%',
        zIndex: 9999,
      }}
      data-testid="ai-voice-copilot-bar"
    >
      <div
        style={{
          backgroundColor: 'var(--bg-page)',
          border: '1px solid var(--border-color)',
          borderRadius: '16px',
          boxShadow: 'var(--shadow-xl)',
          padding: '1rem 1.25rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.85rem',
        }}
      >
        {/* Top Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Sparkles size={18} style={{ color: 'var(--purple-secondary)' }} />
            <span style={{ fontSize: '0.85rem', fontWeight: 800, color: 'var(--dark-navy)' }}>
              AI Voice Action Copilot
            </span>
            <span style={{ fontSize: '0.65rem', fontWeight: 800, padding: '0.1rem 0.4rem', borderRadius: '4px', backgroundColor: 'var(--bg-column)', color: 'var(--gray-text)' }}>
              ⌘+Shift+V
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--gray-text)' }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Action Chip Preview */}
        {parsedAction && (
          <div
            style={{
              padding: '0.85rem 1rem',
              backgroundColor: 'rgba(117, 57, 145, 0.08)',
              border: '1px solid var(--purple-secondary)',
              borderRadius: '10px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '1rem',
            }}
            data-testid="voice-action-preview-chip"
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
              <span style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--dark-navy)' }}>
                ⚡ {parsedAction.summary}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <button
                type="button"
                onClick={() => setParsedAction(null)}
                style={{ padding: '0.35rem 0.75rem', backgroundColor: 'transparent', border: '1px solid var(--border-color)', borderRadius: '6px', fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer' }}
              >
                Zrušit
              </button>
              <button
                type="button"
                onClick={handleExecuteAction}
                style={{ padding: '0.35rem 0.85rem', backgroundColor: 'var(--purple-secondary)', color: '#fff', border: 'none', borderRadius: '6px', fontSize: '0.78rem', fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.3rem' }}
                data-testid="confirm-voice-action-btn"
              >
                <Check size={14} /> Potvrdit akci (Enter)
              </button>
            </div>
          </div>
        )}

        {/* Input Bar with Mic */}
        {error && (
          <div style={{ fontSize: '0.78rem', color: 'var(--danger)', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <AlertCircle size={14} /> {error}
          </div>
        )}

        <form onSubmit={handleProcessTranscript} style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
          <button
            type="button"
            onClick={toggleRecording}
            style={{
              width: '40px',
              height: '40px',
              borderRadius: '50%',
              backgroundColor: isRecording ? 'var(--danger)' : 'rgba(117, 57, 145, 0.12)',
              color: isRecording ? '#fff' : 'var(--purple-secondary)',
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              transition: 'all 0.2s ease',
            }}
            title={isRecording ? 'Zastavit nahrávání' : 'Spustit nahrávání hlasu (cs-CZ)'}
            data-testid="toggle-voice-record-btn"
          >
            {isRecording ? <MicOff size={20} className="ai-pulse" /> : <Mic size={20} />}
          </button>

          <input
            type="text"
            placeholder={isRecording ? 'Poslouchám... (diktujte v češtině)' : 'Řekněte nebo napište příkaz pro nástěnku...'}
            value={transcript}
            onChange={(e) => setTranscript(e.target.value)}
            style={{
              flex: 1,
              padding: '0.65rem 0.85rem',
              borderRadius: '8px',
              border: '1px solid var(--border-color)',
              fontSize: '0.85rem',
              outline: 'none',
            }}
            data-testid="voice-transcript-input"
          />

          <button
            type="submit"
            disabled={!transcript.trim() || isLoading}
            style={{
              padding: '0.65rem 1rem',
              backgroundColor: 'var(--purple-secondary)',
              color: 'var(--text-on-accent)',
              border: 'none',
              borderRadius: '8px',
              fontSize: '0.82rem',
              fontWeight: 700,
              cursor: !transcript.trim() || isLoading ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '0.35rem',
            }}
            data-testid="send-voice-transcript-btn"
          >
            {isLoading ? 'Překládám...' : <Send size={16} />}
          </button>
        </form>
      </div>
    </div>
  );
}
