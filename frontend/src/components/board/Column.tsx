import { Plus } from 'lucide-react';
import { Column as ColumnType, Card, ColumnRole } from '../../types/kanban';
import ColumnHeader from './ColumnHeader';
import KanbanCard from './KanbanCard';

interface ColumnProps {
  column: ColumnType;
  draggedOverColumnId: string | null;
  draggingCardId: string | null;
  editingColumnId: string | null;
  editNameText: string;
  onEditNameTextChange: (value: string) => void;
  onStartEditColumn: (columnId: string, currentName: string) => void;
  onSaveColumnName: (columnId: string) => void;
  onKeyDownColumnName: (e: React.KeyboardEvent, columnId: string) => void;
  onOpenAddModal: (columnId: string) => void;
  onOpenEditModal: (columnId: string, card: Card) => void;
  onDeleteCard: (columnId: string, cardId: string) => void;
  onDragStart: (e: React.DragEvent, cardId: string, columnId: string) => void;
  onDragEnd: () => void;
  onDragOverColumn: (e: React.DragEvent, columnId: string) => void;
  onDrop: (e: React.DragEvent, columnId: string) => void;
  onDeleteColumn: (columnId: string) => void;
  onMoveColumn: (columnId: string, direction: 'left' | 'right') => void;
  onSetColumnRole?: (columnId: string, role: ColumnRole | null) => void;
  isFirst: boolean;
  isLast: boolean;
  onColumnDragStart: (e: React.DragEvent, columnId: string) => void;
  onColumnDragOver: (e: React.DragEvent) => void;
  onColumnDrop: (e: React.DragEvent, columnId: string) => void;
}

export default function Column({
  column,
  draggedOverColumnId,
  draggingCardId,
  editingColumnId,
  editNameText,
  onEditNameTextChange,
  onStartEditColumn,
  onSaveColumnName,
  onKeyDownColumnName,
  onOpenAddModal,
  onOpenEditModal,
  onDeleteCard,
  onDragStart,
  onDragEnd,
  onDragOverColumn,
  onDrop,
  onDeleteColumn,
  onMoveColumn,
  onSetColumnRole,
  isFirst, isLast,
  onColumnDragStart,
  onColumnDragOver,
  onColumnDrop,
}: ColumnProps) {
  return (
    <section
      className={`column ${draggedOverColumnId === column.id ? 'drag-over' : ''}`}
      draggable={true}
      onDragStart={(e) => onColumnDragStart(e, column.id)}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('text/column-id')) {
          onColumnDragOver(e);
        } else {
          onDragOverColumn(e, column.id);
        }
      }}
      onDragEnter={(e) => e.preventDefault()}
      onDrop={(e) => {
        if (e.dataTransfer.types.includes('text/column-id')) {
          onColumnDrop(e, column.id);
        } else {
          onDrop(e, column.id);
        }
      }}
      data-testid={`column-${column.id}`}
    >
      <ColumnHeader
        columnId={column.id}
        columnName={column.name}
        cardCount={column.cards.length}
        editingColumnId={editingColumnId}
        editNameText={editNameText}
        onEditNameTextChange={onEditNameTextChange}
        onStartEdit={onStartEditColumn}
        onSave={onSaveColumnName}
        onKeyDown={onKeyDownColumnName}
        onAddCard={onOpenAddModal}
        onDeleteColumn={onDeleteColumn}
        onMoveColumn={onMoveColumn}
        role={column.role ?? null}
        onSetRole={onSetColumnRole}
        isFirst={isFirst}
        isLast={isLast}
      />

      <div className="cards-list" data-testid={`cards-list-${column.id}`}>
        {column.cards.map((card) => (
          <KanbanCard
            key={card.id}
            card={card}
            columnId={column.id}
            isDragging={draggingCardId === card.id}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onEdit={onOpenEditModal}
            onDelete={onDeleteCard}
          />
        ))}
      </div>

      <button
        type="button"
        className="column-add-card-btn"
        onClick={() => onOpenAddModal(column.id)}
        data-testid={`add-card-btn-${column.id}`}
      >
        <Plus size={14} />
        <span>Nový úkol</span>
      </button>
    </section>
  );
}
