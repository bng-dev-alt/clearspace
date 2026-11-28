'use client';

import React, { useState, useEffect, useRef } from 'react';
import { Search, X, LayoutGrid, FileText, ArrowRight } from 'lucide-react';
import { Column, TaskResource, Card } from '../../types/kanban';
import { searchService, SearchResultItem } from '../../services/searchService';

interface GlobalSearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  columns: Column[];
  resources?: TaskResource[];
  onSelectCard: (columnId: string, card: Card) => void;
}

export default function GlobalSearchModal({
  isOpen,
  onClose,
  columns,
  resources = [],
  onSelectCard,
}: GlobalSearchModalProps) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<'all' | 'card' | 'resource'>('all');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Otevření modalu = čistý start (prázdný dotaz, fokus v poli).
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 50);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setQuery('');
      setSelectedIndex(0);
    }
  }, [isOpen]);

  const rawResults = searchService.searchBoardData(query, columns, resources);
  const results = rawResults.filter((r) => category === 'all' || r.type === category);

  // Po změně dotazu nebo filtru je předchozí zvýrazněný výsledek neplatný.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedIndex(0);
  }, [query, category]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (results.length > 0 ? (prev + 1) % results.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (results.length > 0 ? (prev - 1 + results.length) % results.length : 0));
    } else if (e.key === 'Enter' && results[selectedIndex]) {
      e.preventDefault();
      handleSelectResult(results[selectedIndex]);
    }
  };

  const handleSelectResult = (item: SearchResultItem) => {
    if (item.type === 'card' && item.columnId && item.cardId) {
      const col = columns.find((c) => c.id === item.columnId);
      const card = col?.cards.find((c) => c.id === item.cardId);
      if (col && card) {
        onSelectCard(col.id, card);
        onClose();
      }
    }
  };

  if (!isOpen) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(3, 33, 71, 0.65)',
        backdropFilter: 'blur(4px)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '10vh',
        paddingLeft: '1rem',
        paddingRight: '1rem',
      }}
      onClick={onClose}
      data-testid="global-search-modal"
    >
      <div
        style={{
          backgroundColor: 'var(--bg-page)',
          borderRadius: '12px',
          maxWidth: '680px',
          width: '100%',
          boxShadow: 'var(--shadow-xl)',
          border: '1px solid var(--border-color)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Search Input Bar */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.75rem',
            padding: '1rem 1.25rem',
            borderBottom: '1px solid var(--border-color)',
            backgroundColor: 'var(--surface-1)',
          }}
        >
          <Search size={20} style={{ color: 'var(--purple-secondary)' }} />
          <input
            ref={inputRef}
            type="text"
            placeholder="Hledat karty, úkoly, podklady, akceptační kritéria... (Esc pro zavření)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{
              flex: 1,
              border: 'none',
              background: 'transparent',
              fontSize: '1rem',
              fontWeight: 600,
              color: 'var(--dark-navy)',
              outline: 'none',
            }}
            data-testid="global-search-input"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--gray-text)' }}
            >
              <X size={16} />
            </button>
          )}
        </div>

        {/* Category Filters */}
        <div
          style={{
            display: 'flex',
            gap: '0.4rem',
            padding: '0.6rem 1.25rem',
            borderBottom: '1px solid var(--border-color)',
            backgroundColor: 'var(--bg-column)',
          }}
        >
          {([
            { id: 'all', label: 'Vše' },
            { id: 'card', label: 'Karty & Úkoly' },
            { id: 'resource', label: 'Dokumenty & Přílohy' },
          ] as const).map((cat) => (
            <button
              key={cat.id}
              type="button"
              onClick={() => setCategory(cat.id)}
              style={{
                padding: '0.25rem 0.65rem',
                borderRadius: '6px',
                border: 'none',
                fontSize: '0.75rem',
                fontWeight: 700,
                cursor: 'pointer',
                backgroundColor: category === cat.id ? 'var(--purple-secondary)' : 'transparent',
                color: category === cat.id ? 'var(--text-on-accent)' : 'var(--gray-text)',
              }}
            >
              {cat.label}
            </button>
          ))}
        </div>

        {/* Results List */}
        <div style={{ maxHeight: '380px', overflowY: 'auto', padding: '0.5rem' }}>
          {!query.trim() ? (
            <div style={{ textAlign: 'center', padding: '2.5rem 1rem', color: 'var(--gray-text)' }}>
              <Search size={32} style={{ margin: '0 auto 0.5rem', opacity: 0.4 }} />
              <p style={{ margin: 0, fontSize: '0.85rem' }}>Zadejte výraz pro vyhledání v nástěnce a podkladech...</p>
            </div>
          ) : results.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '2.5rem 1rem', color: 'var(--gray-text)' }}>
              <p style={{ margin: 0, fontSize: '0.85rem' }}>Žádné výsledky neodpovídají dotazu &quot;{query}&quot;.</p>
            </div>
          ) : (
            results.map((item, idx) => {
              const isSelected = idx === selectedIndex;
              return (
                <div
                  key={item.id}
                  onClick={() => handleSelectResult(item)}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '0.65rem 0.85rem',
                    borderRadius: '8px',
                    backgroundColor: isSelected ? 'rgba(117, 57, 145, 0.08)' : 'transparent',
                    cursor: 'pointer',
                    transition: 'background 0.1s ease',
                  }}
                  data-testid={`search-result-${idx}`}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', overflow: 'hidden' }}>
                    {item.type === 'card' ? (
                      <LayoutGrid size={16} style={{ color: 'var(--purple-secondary)', flexShrink: 0 }} />
                    ) : (
                      <FileText size={16} style={{ color: 'var(--blue-primary)', flexShrink: 0 }} />
                    )}
                    <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                        <span style={{ fontWeight: 700, fontSize: '0.85rem', color: 'var(--dark-navy)' }}>
                          {item.title}
                        </span>
                        {item.columnName && (
                          <span
                            style={{
                              fontSize: '0.65rem',
                              fontWeight: 700,
                              padding: '0.1rem 0.4rem',
                              borderRadius: '4px',
                              backgroundColor: 'var(--bg-column)',
                              color: 'var(--gray-text)',
                            }}
                          >
                            {item.columnName}
                          </span>
                        )}
                      </div>
                      <span style={{ fontSize: '0.73rem', color: 'var(--gray-text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {item.snippet}
                      </span>
                    </div>
                  </div>

                  <ArrowRight size={14} style={{ color: isSelected ? 'var(--purple-secondary)' : 'transparent', flexShrink: 0 }} />
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
