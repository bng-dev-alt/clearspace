import React, { useState } from 'react';
import { Search, Settings, ArrowUpDown, Plus, Filter, RotateCcw, Sparkles, Info, History } from 'lucide-react';
import { Column, TeamMember } from '../../types/kanban';
import TagDropdown from './TagDropdown';

interface ToolbarProps {
  searchQuery: string;
  onSearchChange: (value: string) => void;
  selectedTag: string;
  onSelectTag: (tag: string) => void;
  selectedPriority: string;
  onSelectPriority: (value: string) => void;
  selectedAssignee: string;
  onSelectAssignee: (value: string) => void;
  selectedStatus: string;
  onSelectStatus: (value: string) => void;
  selectedDueDateFilter: string;
  onSelectDueDateFilter: (value: string) => void;
  selectedHasChecklist: string;
  onSelectHasChecklist: (value: string) => void;
  selectedHasComments: string;
  onSelectHasComments: (value: string) => void;
  selectedArchivedFilter: string;
  onSelectArchivedFilter: (value: string) => void;
  sortBy: string;
  onSortChange: (value: string) => void;
  tags: string[];
  columns: Column[];
  onAddTag: (tag: string) => void;
  onDeleteTag: (tag: string) => void;
  onNewTask: () => void;
  onOpenIntelligence: () => void;
  intelHealth?: { level: 'healthy' | 'attention' | 'risk'; label: string; reason: string };
  isHeroHidden: boolean;
  onToggleHero: () => void;
  teamMembers: TeamMember[];
  onManageTeam: () => void;
  onOpenActivityFeed: () => void;
}

export default function Toolbar({
  searchQuery, onSearchChange,
  selectedTag, onSelectTag,
  selectedPriority, onSelectPriority,
  selectedAssignee, onSelectAssignee,
  selectedStatus, onSelectStatus,
  selectedDueDateFilter, onSelectDueDateFilter,
  selectedHasChecklist, onSelectHasChecklist,
  selectedHasComments, onSelectHasComments,
  selectedArchivedFilter, onSelectArchivedFilter,
  sortBy, onSortChange,
  tags, columns, onAddTag, onDeleteTag,
  onNewTask,
  onOpenIntelligence,
  intelHealth,
  isHeroHidden,
  onToggleHero,
  teamMembers,
  onManageTeam,
  onOpenActivityFeed,
}: ToolbarProps) {
  const [showFilters, setShowFilters] = useState(false);

  // Spočítáme počet aktivních filtrů (mimo výchozích stavů)
  const activeFilters = [
    selectedTag,
    selectedPriority,
    selectedAssignee,
    selectedStatus,
    selectedDueDateFilter,
    selectedHasChecklist,
    selectedHasComments,
    selectedArchivedFilter !== 'active' ? selectedArchivedFilter : '',
  ].filter(Boolean);
  
  const activeFilterCount = activeFilters.length;

  const handleClearFilters = () => {
    onSelectTag('');
    onSelectPriority('');
    onSelectAssignee('');
    onSelectStatus('');
    onSelectDueDateFilter('');
    onSelectHasChecklist('');
    onSelectHasComments('');
    onSelectArchivedFilter('active');
  };

  return (
    <section className="app-toolbar">
      {/* Hlavní řada (vždy viditelná) -- layout řeší CSS, aby šel měnit na breakpointech */}
      <div className="toolbar-main-row">
        <div className="toolbar-left">
          <div className="toolbar-search-wrapper">
            <Search size={16} className="search-icon" />
            <input
              type="text"
              className="toolbar-search-input"
              placeholder="Hledat karty..."
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              data-testid="search-input"
            />
          </div>

          <div className="toolbar-divider" />

          {/* Tlačítko pro rozbalení/sbalení filtrů */}
          <button
            type="button"
            onClick={() => setShowFilters(!showFilters)}
            className={`toolbar-filter-toggle-btn ${activeFilterCount > 0 ? 'active' : ''}`}
            data-testid="filter-toggle-btn"
          >
            <Filter size={14} />
            <span>Filtry</span>
            {activeFilterCount > 0 && (
              <span className="active-filter-badge">{activeFilterCount}</span>
            )}
          </button>

          {activeFilterCount > 0 && (
            <button
              type="button"
              onClick={handleClearFilters}
              className="toolbar-clear-filters-btn"
              title="Vymazat všechny filtry"
              data-testid="clear-filters-btn"
            >
              <RotateCcw size={12} style={{ marginRight: '4px' }} />
              Vymazat filtry
            </button>
          )}

          <div className="toolbar-divider" />

          {/* Řazení necháme v hlavní liště pro rychlý přístup */}
          <div className="toolbar-sort-wrapper">
            <ArrowUpDown size={14} className="sort-icon" />
            <select
              className="toolbar-select"
              value={sortBy}
              onChange={(e) => onSortChange(e.target.value)}
              data-testid="sort-by"
            >
              <option value="">Výchozí řazení</option>
              <option value="created">Datum vytvoření</option>
              <option value="updated">Datum poslední úpravy</option>
              <option value="dueDate">Termín splnění</option>
              <option value="priority">Priorita</option>
              <option value="alphabetical">Abecedně</option>
            </select>
          </div>

          <div className="toolbar-divider" />

          {/* Team Members List inside Toolbar */}
          <div className="toolbar-team-section" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              {teamMembers.slice(0, 4).map((member, index) => (
                <div
                  key={member.id}
                  style={{
                    width: '24px',
                    height: '24px',
                    borderRadius: '50%',
                    backgroundColor: member.avatarColor,
                    color: '#ffffff',
                    fontSize: '0.65rem',
                    fontWeight: 700,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    border: '1.5px solid var(--bg-page)',
                    marginLeft: index > 0 ? '-6px' : '0px',
                    zIndex: 5 - index,
                    cursor: 'pointer',
                  }}
                  title={member.fullName}
                  onClick={onManageTeam}
                  data-testid={`toolbar-avatar-${member.id}`}
                >
                  {member.initials}
                </div>
              ))}
              {teamMembers.length > 4 && (
                <div
                  style={{
                    width: '24px',
                    height: '24px',
                    borderRadius: '50%',
                    backgroundColor: 'var(--border-color)',
                    color: 'var(--dark-navy)',
                    fontSize: '0.65rem',
                    fontWeight: 700,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    border: '1.5px solid var(--bg-page)',
                    marginLeft: '-6px',
                    zIndex: 1,
                    cursor: 'pointer',
                  }}
                  title="Zobrazit všechny členy"
                  onClick={onManageTeam}
                  data-testid="toolbar-avatar-more"
                >
                  +{teamMembers.length - 4}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={onManageTeam}
              className="toolbar-team-label"
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--blue-primary)',
                fontSize: '0.75rem',
                fontWeight: 700,
                cursor: 'pointer',
                padding: '2px 4px',
              }}
              data-testid="toolbar-manage-team-btn"
            >
              Členové projektu
            </button>
          </div>
        </div>

        <div className="toolbar-right">
          <button
            type="button"
            className="toolbar-settings-btn"
            title="Nastavení (připravujeme)"
            aria-label="Nastavení (připravujeme)"
            disabled
            style={{ opacity: 0.55, cursor: 'not-allowed' }}
          >
            <Settings size={18} />
          </button>

          <button
            type="button"
            onClick={onToggleHero}
            className="toolbar-settings-btn"
            title={isHeroHidden ? 'Zobrazit info' : 'Skrýt info'}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: 'none',
              background: 'none',
              padding: '6px',
              borderRadius: '4px',
              cursor: 'pointer',
              color: isHeroHidden ? 'var(--gray-text)' : 'var(--blue-primary)',
              transition: 'color 0.2s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = 'var(--dark-navy)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = isHeroHidden ? 'var(--gray-text)' : 'var(--blue-primary)';
            }}
            data-testid="toolbar-toggle-hero-btn"
          >
            <Info size={18} />
          </button>

          <button
            type="button"
            onClick={onOpenActivityFeed}
            className="toolbar-settings-btn"
            title="Aktivita projektu"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: 'none',
              background: 'none',
              padding: '6px',
              borderRadius: '4px',
              cursor: 'pointer',
              color: 'var(--gray-text)',
              transition: 'color 0.2s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = 'var(--dark-navy)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = 'var(--gray-text)';
            }}
            data-testid="activity-feed-btn"
          >
            <History size={18} />
          </button>

          {/* Jeden inteligentní vstupní bod místo seznamu AI tlačítek.
              Pulse dot nese živý stav zdraví projektu (ambientní inteligence).
              Generate / Sprint / Risk žijí uvnitř panelu jako kontextové akce. */}
          <button
            type="button"
            className="cs-btn cs-btn--primary pi-chip-btn"
            onClick={onOpenIntelligence}
            title={intelHealth ? `${intelHealth.label} — ${intelHealth.reason} (⌘I)` : 'Project Intelligence (⌘I)'}
            data-testid="project-intelligence-btn"
          >
            <Sparkles size={14} />
            Project Intelligence
            {intelHealth && (
              <span
                className={`pi-chip-dot pi-chip-${intelHealth.level}`}
                aria-label={intelHealth.label}
                data-testid="pi-chip-dot"
              />
            )}
          </button>

          <button
            type="button"
            className="cs-btn cs-btn--primary toolbar-new-task-btn"
            onClick={onNewTask}
            data-testid="new-task-btn"
          >
            <Plus size={16} />
            Nový úkol
          </button>
        </div>
      </div>

      {/* Rozbalovací panel pokročilých filtrů */}
      {showFilters && (
        <div className="toolbar-expanded-filters" data-testid="expanded-filters-panel">
          <TagDropdown
            tags={tags}
            selectedTag={selectedTag}
            columns={columns}
            onSelectTag={onSelectTag}
            onAddTag={onAddTag}
            onDeleteTag={onDeleteTag}
          />

          <select
            className="toolbar-select"
            value={selectedPriority}
            onChange={(e) => onSelectPriority(e.target.value)}
            data-testid="priority-filter"
          >
            <option value="">Všechny priority</option>
            <option value="Low">Nízká</option>
            <option value="Medium">Střední</option>
            <option value="High">Vysoká</option>
          </select>

          <select
            className="toolbar-select"
            value={selectedStatus}
            onChange={(e) => onSelectStatus(e.target.value)}
            data-testid="status-filter"
          >
            <option value="">Všechny sloupce</option>
            {columns.map((col) => (
              <option key={col.id} value={col.id}>{col.name}</option>
            ))}
          </select>

          <select
            className="toolbar-select"
            value={selectedAssignee}
            onChange={(e) => onSelectAssignee(e.target.value)}
            data-testid="assignee-filter"
          >
            <option value="">Všichni řešitelé</option>
            <option value="unassigned">Nepřiřazeno</option>
            {teamMembers.map((member) => (
              <option key={member.id} value={member.fullName}>{member.fullName}</option>
            ))}
          </select>

          <select
            className="toolbar-select"
            value={selectedDueDateFilter}
            onChange={(e) => onSelectDueDateFilter(e.target.value)}
            data-testid="duedate-filter"
          >
            <option value="">Libovolný termín</option>
            <option value="today">Dnes</option>
            <option value="week">Tento týden</option>
            <option value="overdue">Po termínu</option>
            <option value="none">Bez termínu</option>
          </select>

          <select
            className="toolbar-select"
            value={selectedHasChecklist}
            onChange={(e) => onSelectHasChecklist(e.target.value)}
            data-testid="checklist-filter"
          >
            <option value="">Checklist: Vše</option>
            <option value="yes">S checklistem</option>
            <option value="no">Bez checklistu</option>
          </select>

          <select
            className="toolbar-select"
            value={selectedHasComments}
            onChange={(e) => onSelectHasComments(e.target.value)}
            data-testid="comments-filter"
          >
            <option value="">Komentáře: Vše</option>
            <option value="yes">S komentáři</option>
            <option value="no">Bez komentářů</option>
          </select>

          <select
            className="toolbar-select"
            value={selectedArchivedFilter}
            onChange={(e) => onSelectArchivedFilter(e.target.value)}
            data-testid="archived-filter"
          >
            <option value="active">Aktivní úkoly</option>
            <option value="archived">Archivované úkoly</option>
            <option value="all">Všechny úkoly</option>
          </select>
        </div>
      )}
    </section>
  );
}
