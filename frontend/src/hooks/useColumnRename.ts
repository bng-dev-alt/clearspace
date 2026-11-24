import { useState, useCallback, useRef } from 'react';

export function useColumnRename(renameColumn: (columnId: string, newName: string, expectedName?: string) => void) {
  const [editingColumnId, setEditingColumnId] = useState<string | null>(null);
  const [editNameText, setEditNameText] = useState('');
  // Name when editing started: the save only applies if nobody renamed the column meanwhile (RUN 01B).
  const startName = useRef<string | undefined>(undefined);

  const handleStartEdit = useCallback((columnId: string, currentName: string) => {
    setEditingColumnId(columnId);
    setEditNameText(currentName);
    startName.current = currentName;
  }, []);

  const handleSave = useCallback((columnId: string) => {
    if (!editNameText.trim()) {
      setEditingColumnId(null);
      return;
    }
    if (editNameText.trim() !== startName.current) renameColumn(columnId, editNameText.trim(), startName.current);
    setEditingColumnId(null);
  }, [editNameText, renameColumn]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent, columnId: string) => {
    if (e.key === 'Enter') {
      handleSave(columnId);
    } else if (e.key === 'Escape') {
      setEditingColumnId(null);
    }
  }, [handleSave]);

  return {
    editingColumnId,
    editNameText,
    setEditNameText,
    handleStartEdit,
    handleSave,
    handleKeyDown,
  };
}
