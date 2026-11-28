'use client';

import React, { useState } from 'react';
import { DialogFocus } from './ui/useDialogFocus';
import { X } from 'lucide-react';
import { TeamMember, Assignee } from '../types/kanban';
import MultiAssigneeSelect from './board/MultiAssigneeSelect';

interface AddCardModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (
    title: string,
    details: string,
    tag?: string,
    priority?: 'Low' | 'Medium' | 'High',
    assignee?: Assignee,
    dueDate?: string,
    assignees?: TeamMember[]
  ) => void;
  columnName: string;
  availableTags: string[];
  teamMembers: TeamMember[];
}

export default function AddCardModal({
  isOpen,
  onClose,
  onSubmit,
  columnName,
  availableTags,
  teamMembers,
}: AddCardModalProps) {
  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');
  const [tag, setTag] = useState<string>('');
  const [priority, setPriority] = useState<string>('Medium');
  const [selectedAssignees, setSelectedAssignees] = useState<TeamMember[]>([]);
  const [dueDate, setDueDate] = useState<string>('');
  const [error, setError] = useState('');

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      setError('Název karty je povinný');
      return;
    }
    
    const selectedTag = tag ? tag : undefined;
    const selectedPriority = priority ? (priority as 'Low' | 'Medium' | 'High') : undefined;
    const selectedDueDate = dueDate || undefined;

    // Derived primary assignee for backward compatibility
    const primaryAssignee = selectedAssignees.length > 0 ? {
      name: selectedAssignees[0].fullName,
      initials: selectedAssignees[0].initials,
      color: selectedAssignees[0].avatarColor
    } : undefined;

    onSubmit(
      title.trim(),
      details.trim(),
      selectedTag,
      selectedPriority,
      primaryAssignee,
      selectedDueDate,
      selectedAssignees
    );
    // Reset states on success
    setTitle('');
    setDetails('');
    setTag('');
    setPriority('Medium');
    setSelectedAssignees([]);
    setDueDate('');
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose} data-testid="modal-overlay">
      <div
        className="modal-content"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <DialogFocus />
        <div className="modal-header">
          <h2 className="modal-title">Přidat kartu do: {columnName}</h2>
          <button
            type="button"
            className="modal-close-btn"
            onClick={onClose}
            aria-label="Zavřít okno"
          >
            <X size={20} />
          </button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            <div className="form-group">
              <label htmlFor="card-title" className="form-label">
                Název *
              </label>
              <input
                id="card-title"
                type="text"
                className="form-input"
                placeholder="Zadejte název karty"
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  if (error) setError('');
                }}
                autoFocus
              />
              {error && (
                <p style={{ color: 'var(--danger)', fontSize: '0.75rem', marginTop: '0.25rem' }}>
                  {error}
                </p>
              )}
            </div>
            
            <div className="form-group">
              <label htmlFor="card-details" className="form-label">
                Podrobnosti
              </label>
              <textarea
                id="card-details"
                className="form-textarea"
                placeholder="Zadejte podrobnosti nebo popis"
                value={details}
                onChange={(e) => setDetails(e.target.value)}
              />
            </div>

            <div className="modal-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginTop: '1rem' }}>
              <div className="form-group">
                <label htmlFor="card-tag" className="form-label">
                  Štítek
                </label>
                <select
                  id="card-tag"
                  className="form-input"
                  value={tag}
                  onChange={(e) => setTag(e.target.value)}
                >
                  <option value="">Žádný</option>
                  {availableTags.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>

              <div className="form-group">
                <label htmlFor="card-priority" className="form-label">
                  Priorita
                </label>
                <select
                  id="card-priority"
                  className="form-input"
                  value={priority}
                  onChange={(e) => setPriority(e.target.value)}
                >
                  <option value="Low">Nízká</option>
                  <option value="Medium">Střední</option>
                  <option value="High">Vysoká</option>
                </select>
              </div>

              <div className="form-group" style={{ gridColumn: 'span 2' }}>
                <label htmlFor="card-duedate" className="form-label">
                  Termín splnění
                </label>
                <input
                  id="card-duedate"
                  type="date"
                  className="form-input"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                />
              </div>

              <div className="form-group" style={{ gridColumn: 'span 2' }}>
                <label className="form-label">Přiřazeno</label>
                <MultiAssigneeSelect
                  selected={selectedAssignees}
                  teamMembers={teamMembers}
                  onChange={setSelectedAssignees}
                  placeholder="Přiřadit členy..."
                />
              </div>
            </div>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-cancel" onClick={onClose}>
              Zrušit
            </button>
            <button type="submit" className="btn btn-submit">
              Přidat kartu
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
