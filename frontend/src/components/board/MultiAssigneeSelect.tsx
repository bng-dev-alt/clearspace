'use client';

import React, { useState, useRef, useEffect, useMemo } from 'react';
import { readableOn } from '../../lib/color';
import { Search, Check, X, UserPlus } from 'lucide-react';
import { TeamMember } from '../../types/kanban';

interface MultiAssigneeSelectProps {
  selected: TeamMember[];
  teamMembers: TeamMember[];
  onChange: (selected: TeamMember[]) => void;
  placeholder?: string;
}

export default function MultiAssigneeSelect({
  selected,
  teamMembers,
  onChange,
  placeholder = 'Přiřadit členy...',
}: MultiAssigneeSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Reset active index when search or open state changes
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActiveIndex(-1);
    if (isOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [search, isOpen]);

  // Filtered members based on search query
  const filteredMembers = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return teamMembers;
    return teamMembers.filter((m) =>
      m.fullName.toLowerCase().includes(query) ||
      (m.email && m.email.toLowerCase().includes(query))
    );
  }, [teamMembers, search]);

  const handleToggle = (member: TeamMember) => {
    const isSelected = selected.some((m) => m.id === member.id);
    let newSelected: TeamMember[];
    if (isSelected) {
      newSelected = selected.filter((m) => m.id !== member.id);
    } else {
      newSelected = [...selected, member];
    }
    onChange(newSelected);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        setIsOpen(true);
      }
      return;
    }

    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        setIsOpen(false);
        break;
      case 'ArrowDown':
        e.preventDefault();
        setActiveIndex((prev) =>
          prev < filteredMembers.length - 1 ? prev + 1 : prev
        );
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIndex((prev) => (prev > 0 ? prev - 1 : 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (activeIndex >= 0 && activeIndex < filteredMembers.length) {
          handleToggle(filteredMembers[activeIndex]);
        }
        break;
      case 'Tab':
        setIsOpen(false);
        break;
      default:
        break;
    }
  };

  return (
    <div
      ref={containerRef}
      className="multi-assignee-select-container"
      style={{ position: 'relative', width: '100%' }}
      onKeyDown={handleKeyDown}
    >
      {/* Trigger Button or Selected List */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', alignItems: 'center' }}>
        {selected.map((member) => (
          <div
            key={member.id}
            className="selected-assignee-badge"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.25rem',
              backgroundColor: 'var(--bg-column)',
              border: '1px solid var(--border-color)',
              borderRadius: '16px',
              padding: '2px 8px 2px 4px',
              fontSize: '0.75rem',
              fontWeight: 600,
            }}
            data-testid={`selected-badge-${member.id}`}
          >
            <div
              style={{
                width: '18px',
                height: '18px',
                borderRadius: '50%',
                backgroundColor: member.avatarColor,
                color: readableOn(member.avatarColor),
                fontSize: '0.6rem',
                fontWeight: 700,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {member.initials}
            </div>
            <span>{member.fullName}</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                handleToggle(member);
              }}
              style={{
                border: 'none',
                background: 'none',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                padding: '1px',
                color: 'var(--gray-text)',
              }}
              aria-label={`Odebrat ${member.fullName}`}
              className="assignee-badge-remove"
              data-testid={`remove-badge-${member.id}`}
            >
              <X size={12} />
            </button>
          </div>
        ))}

        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          className={`multi-select-trigger-btn ${isOpen ? 'active' : ''}`}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.35rem',
            padding: '4px 10px',
            fontSize: '0.75rem',
            fontWeight: 600,
            backgroundColor: 'transparent',
            border: '1px dashed var(--border-color)',
            borderRadius: '6px',
            cursor: 'pointer',
            color: 'var(--gray-text)',
            transition: 'all 0.2s ease',
          }}
          data-testid="multi-assignee-trigger"
        >
          <UserPlus size={12} />
          <span>{selected.length === 0 ? placeholder : 'Přiřadit další...'}</span>
        </button>
      </div>

      {/* Dropdown Menu */}
      {isOpen && (
        <div
          className="multi-select-dropdown"
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            zIndex: 150,
            width: '100%',
            minWidth: '240px',
            marginTop: '0.25rem',
            backgroundColor: 'var(--surface)',
            border: '1px solid var(--border-color)',
            borderRadius: '8px',
            boxShadow: '0 4px 20px rgba(0,0,0,0.08)',
            padding: '0.5rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.35rem',
          }}
          data-testid="multi-assignee-dropdown"
        >
          {/* Search Box */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
              borderBottom: '1px solid var(--border-color)',
              paddingBottom: '0.4rem',
              paddingLeft: '0.25rem',
              paddingRight: '0.25rem',
            }}
          >
            <Search size={14} style={{ color: 'var(--gray-text)' }} />
            <input
              ref={searchInputRef}
              type="text"
              placeholder="Vyhledat člena..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{
                border: 'none',
                outline: 'none',
                fontSize: '0.8rem',
                width: '100%',
                color: 'var(--dark-navy)',
                background: 'transparent',
              }}
              data-testid="multi-assignee-search"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--gray-text)' }}
              >
                <X size={12} />
              </button>
            )}
          </div>

          {/* Members List */}
          <div
            className="multi-select-list"
            style={{
              maxHeight: '180px',
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: '2px',
            }}
          >
            {filteredMembers.length === 0 ? (
              <span
                style={{
                  fontSize: '0.75rem',
                  color: 'var(--gray-text)',
                  textAlign: 'center',
                  padding: '1rem 0',
                }}
              >
                Žádní členové nebyli nalezeni.
              </span>
            ) : (
              filteredMembers.map((member, idx) => {
                const isSelected = selected.some((m) => m.id === member.id);
                const isFocused = idx === activeIndex;

                return (
                  <button
                    key={member.id}
                    type="button"
                    onClick={() => handleToggle(member)}
                    onMouseEnter={() => setActiveIndex(idx)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      width: '100%',
                      padding: '6px 8px',
                      borderRadius: '6px',
                      border: 'none',
                      backgroundColor: isFocused
                        ? 'var(--bg-column)'
                        : isSelected
                        ? 'var(--accent-soft)'
                        : 'transparent',
                      textAlign: 'left',
                      cursor: 'pointer',
                      transition: 'all 0.15s ease',
                    }}
                    data-testid={`dropdown-item-${member.id}`}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <div
                        style={{
                          width: '20px',
                          height: '20px',
                          borderRadius: '50%',
                          backgroundColor: member.avatarColor,
                          color: readableOn(member.avatarColor),
                          fontSize: '0.65rem',
                          fontWeight: 700,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        {member.initials}
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
                        <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--dark-navy)' }}>
                          {member.fullName}
                        </span>
                        {member.email && (
                          <span style={{ fontSize: '0.65rem', color: 'var(--gray-text)' }}>
                            {member.email}
                          </span>
                        )}
                      </div>
                    </div>
                    {isSelected && (
                      <Check size={14} style={{ color: 'var(--blue-primary)' }} data-testid={`check-icon-${member.id}`} />
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
