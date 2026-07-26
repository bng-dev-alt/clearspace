import React from 'react';
import { Trash2, Calendar, MoreHorizontal } from 'lucide-react';
import { Card } from '../../types/kanban';
import { translatePriority, getPriorityColor } from '../../utils/kanban';

interface KanbanCardProps {
  card: Card;
  columnId: string;
  isDragging: boolean;
  onDragStart: (e: React.DragEvent, cardId: string, columnId: string) => void;
  onDragEnd: () => void;
  onEdit: (columnId: string, card: Card) => void;
  onDelete: (columnId: string, cardId: string) => void;
}

function KanbanCard({
  card, columnId, isDragging,
  onDragStart, onDragEnd, onEdit, onDelete,
}: KanbanCardProps) {
  return (
    <div
      className={`card ${isDragging ? 'dragging' : ''}`}
      draggable
      onDragStart={(e) => onDragStart(e, card.id, columnId)}
      onDragEnd={onDragEnd}
      onClick={() => onEdit(columnId, card)}
      data-testid={`card-${card.id}`}
    >
      <button
        type="button"
        className="card-delete-btn"
        onClick={(e) => { e.stopPropagation(); onDelete(columnId, card.id); }}
        aria-label={`Smazat kartu: ${card.title}`}
        data-testid={`delete-card-${card.id}`}
      >
        <Trash2 size={14} />
      </button>

      <div className="card-drag-handle">
        <MoreHorizontal size={14} />
      </div>

      <h4 className="card-title">{card.title}</h4>
      {card.details && <p className="card-details">{card.details}</p>}

      {(card.tag || card.priority) && (
        <div className="card-badges-row">
          {card.tag && <span className="cs-badge">{card.tag}</span>}
          {card.priority && (
            <span className="card-priority-badge">
              <span
                className="priority-indicator-dot"
                style={{ backgroundColor: getPriorityColor(card.priority) }}
              />
              {translatePriority(card.priority)}
            </span>
          )}
        </div>
      )}

      <div className="card-footer-row">
        {card.dueDate && (
          <span className="card-due-date" title="Termín splnění">
            <Calendar size={10} className="calendar-icon" />
            {card.dueDate}
          </span>
        )}
        {/* Overlapping avatars of assigned members */}
        {card.assignees && card.assignees.length > 0 ? (
          <div className="card-assignee-group" style={{ display: 'flex', alignItems: 'center' }}>
            {card.assignees.slice(0, 3).map((member, index) => (
              <div
                key={member.id || index}
                className="card-assignee-avatar"
                style={{
                  backgroundColor: member.avatarColor,
                  marginLeft: index > 0 ? '-8px' : '0px',
                  zIndex: 5 - index,
                  width: '24px',
                  height: '24px',
                  borderRadius: '50%',
                  color: '#ffffff',
                  fontSize: '0.65rem',
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  border: '1.5px solid var(--bg-card)',
                  transition: 'transform 0.2s',
                  userSelect: 'none',
                }}
                title={member.fullName}
                data-testid={`card-avatar-${member.id}`}
              >
                {member.initials}
              </div>
            ))}
            {card.assignees.length > 3 && (
              <div
                className="card-assignee-avatar-more"
                style={{
                  backgroundColor: 'var(--border-color)',
                  marginLeft: '-8px',
                  zIndex: 1,
                  width: '24px',
                  height: '24px',
                  borderRadius: '50%',
                  color: 'var(--dark-navy)',
                  fontSize: '0.65rem',
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  border: '1.5px solid var(--bg-card)',
                  userSelect: 'none',
                }}
                title={card.assignees.slice(3).map(m => m.fullName).join(', ')}
                data-testid="card-avatar-more"
              >
                +{card.assignees.length - 3}
              </div>
            )}
          </div>
        ) : card.assignee ? (
          <div
            className="card-assignee-initials"
            style={{ backgroundColor: card.assignee.color }}
            title={card.assignee.name}
            data-testid="card-assignee-legacy"
          >
            {card.assignee.initials}
          </div>
        ) : (
          <div className="card-assignee-unassigned" title="Nepřiřazeno">--</div>
        )}
      </div>
    </div>
  );
}

export default React.memo(KanbanCard);

