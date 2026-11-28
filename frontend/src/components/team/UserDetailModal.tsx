'use client';

import React from 'react';
import { readableOn } from '../../lib/color';
import { X, Mail, Calendar, Shield, CheckSquare, Clock } from 'lucide-react';
import { TeamMember, Card, Column } from '../../types/kanban';

interface UserDetailModalProps {
  isOpen: boolean;
  onClose: () => void;
  member: TeamMember;
  columns?: Column[];
}

export default function UserDetailModal({ isOpen, onClose, member, columns = [] }: UserDetailModalProps) {
  if (!isOpen) return null;

  // Find all cards assigned to this member across columns
  const assignedCards: { card: Card; colName: string }[] = [];
  columns.forEach((col) => {
    col.cards.forEach((card) => {
      const isAssigned =
        card.assignees?.some((m) => m.id === member.id || m.fullName === member.fullName) ||
        card.assignee?.name === member.fullName;
      if (isAssigned) {
        assignedCards.push({ card, colName: col.name });
      }
    });
  });

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(3, 33, 71, 0.65)',
        backdropFilter: 'blur(4px)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1.5rem',
      }}
      onClick={onClose}
      data-testid="user-detail-modal"
    >
      <div
        style={{
          backgroundColor: 'var(--bg-page)',
          borderRadius: '14px',
          maxWidth: '650px',
          width: '100%',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: 'var(--shadow-xl)',
          border: '1px solid var(--border-color)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '1.25rem 1.5rem',
            borderBottom: '1px solid var(--border-color)',
            backgroundColor: 'var(--surface-1)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.8rem' }}>
            <div
              style={{
                width: '42px',
                height: '42px',
                borderRadius: '50%',
                backgroundColor: member.avatarColor || 'var(--purple-secondary)',
                color: readableOn(member.avatarColor || 'var(--purple-secondary)'),
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 800,
                fontSize: '1rem',
              }}
            >
              {member.initials}
            </div>
            <div>
              <h2 style={{ fontSize: '1.1rem', fontWeight: 800, color: 'var(--dark-navy)', margin: 0 }}>
                {member.fullName}
              </h2>
              <span style={{ fontSize: '0.75rem', color: 'var(--gray-text)', margin: 0 }}>
                Role: <strong style={{ color: 'var(--purple-secondary)' }}>{member.role || 'Member'}</strong>
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--gray-text)' }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div style={{ padding: '1.5rem', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          {/* Metadata Grid */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, 1fr)',
              gap: '0.85rem',
              padding: '1rem',
              backgroundColor: 'var(--surface-1)',
              borderRadius: '10px',
              border: '1px solid var(--border-color)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8rem', color: 'var(--dark-navy)' }}>
              <Mail size={16} style={{ color: 'var(--purple-secondary)' }} />
              <span>{member.email || 'Email nebydlen'}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8rem', color: 'var(--dark-navy)' }}>
              <Calendar size={16} style={{ color: 'var(--purple-secondary)' }} />
              <span>Registrován: {new Date(member.createdAt).toLocaleDateString('cs-CZ')}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8rem', color: 'var(--dark-navy)' }}>
              <Shield size={16} style={{ color: 'var(--purple-secondary)' }} />
              <span>Práva: {member.role || 'Member'}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8rem', color: 'var(--dark-navy)' }}>
              <Clock size={16} style={{ color: 'var(--purple-secondary)' }} />
              <span>Stav: Aktívní</span>
            </div>
          </div>

          {/* Assigned Cards */}
          <div>
            <h4 style={{ fontSize: '0.85rem', fontWeight: 800, color: 'var(--dark-navy)', margin: '0 0 0.6rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <CheckSquare size={16} style={{ color: 'var(--purple-secondary)' }} /> Přiřazené úkoly ({assignedCards.length})
            </h4>

            {assignedCards.length === 0 ? (
              <p style={{ fontSize: '0.8rem', color: 'var(--gray-text)', fontStyle: 'italic', margin: 0 }}>
                Uživatel nemá na nástěnce přiřazené žádné karty.
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                {assignedCards.map(({ card, colName }) => (
                  <div
                    key={card.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '0.6rem 0.85rem',
                      backgroundColor: 'var(--surface-1)',
                      border: '1px solid var(--border-color)',
                      borderRadius: '8px',
                    }}
                  >
                    <span style={{ fontWeight: 700, fontSize: '0.82rem', color: 'var(--dark-navy)' }}>
                      {card.title}
                    </span>
                    <span style={{ fontSize: '0.7rem', padding: '0.15rem 0.45rem', borderRadius: '4px', backgroundColor: 'var(--bg-column)', color: 'var(--gray-text)', fontWeight: 600 }}>
                      {colName}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            padding: '0.85rem 1.5rem',
            borderTop: '1px solid var(--border-color)',
            backgroundColor: 'var(--surface-1)',
          }}
        >
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: '0.5rem 1.25rem',
              backgroundColor: 'var(--purple-secondary)',
              color: '#fff',
              border: 'none',
              borderRadius: '6px',
              fontSize: '0.85rem',
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            Zavřít
          </button>
        </div>
      </div>
    </div>
  );
}
