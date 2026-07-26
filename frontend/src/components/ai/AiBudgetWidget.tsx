import React, { useState } from 'react';
import { aiCostEstimator } from '../../services/ai/aiCostEstimator';
import { Edit2, Check, X } from 'lucide-react';

interface AiBudgetWidgetProps {
  monthlyUsage: number;
  budgetLimit: number;
  onBudgetChange: (newLimit: number) => void;
}

export default function AiBudgetWidget({ monthlyUsage, budgetLimit, onBudgetChange }: AiBudgetWidgetProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [tempBudget, setTempBudget] = useState(budgetLimit.toString());

  const handleSave = () => {
    const limit = parseFloat(tempBudget);
    if (!isNaN(limit) && limit >= 0) {
      onBudgetChange(limit);
      setIsEditing(false);
    }
  };

  const percentUsed = budgetLimit > 0 ? (monthlyUsage / budgetLimit) * 100 : 0;
  
  // Dynamic color for progress bar
  let barColor = 'var(--accent)'; // emerald (v normě)
  if (percentUsed >= 100) {
    barColor = 'var(--danger)'; // red
  } else if (percentUsed >= 80) {
    barColor = 'var(--warning)'; // amber
  }

  return (
    <div
      className="cs-card"
      style={{
        padding: '1.25rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.85rem',
        minHeight: '160px',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--dark-navy)' }}>
          Měsíční limit rozpočtu
        </span>
        {isEditing ? (
          <div style={{ display: 'flex', gap: '0.25rem', alignItems: 'center' }}>
            <button
              onClick={handleSave}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: '0.2rem',
                color: 'var(--success)',
                display: 'flex',
                alignItems: 'center',
              }}
            >
              <Check size={16} />
            </button>
            <button
              onClick={() => {
                setTempBudget(budgetLimit.toString());
                setIsEditing(false);
              }}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: '0.2rem',
                color: 'var(--danger)',
                display: 'flex',
                alignItems: 'center',
              }}
            >
              <X size={16} />
            </button>
          </div>
        ) : (
          <button
            className="ai-budget-edit-btn"
            onClick={() => setIsEditing(true)}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: '0.2rem',
              color: 'var(--gray-text)',
              display: 'flex',
              alignItems: 'center',
              transition: 'color 0.2s',
            }}
            onMouseEnter={(e) => e.currentTarget.style.color = 'var(--dark-navy)'}
            onMouseLeave={(e) => e.currentTarget.style.color = 'var(--gray-text)'}
          >
            <Edit2 size={14} />
          </button>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem' }}>
        {isEditing ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
            <input
              type="number"
              value={tempBudget}
              onChange={(e) => setTempBudget(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSave();
                if (e.key === 'Escape') setIsEditing(false);
              }}
              style={{
                width: '100px',
                fontSize: '1.4rem',
                fontWeight: 800,
                color: 'var(--dark-navy)',
                border: '1px solid var(--border-color)',
                borderRadius: 'var(--radius)',
                padding: '0.2rem 0.4rem',
                outline: 'none',
              }}
              autoFocus
            />
            <span style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--dark-navy)' }}>CZK</span>
          </div>
        ) : (
          <>
            <span style={{ fontSize: '1.8rem', fontWeight: 800, color: 'var(--dark-navy)' }}>
              {aiCostEstimator.formatCostCzk(monthlyUsage)}
            </span>
            <span style={{ fontSize: '0.85rem', color: 'var(--gray-text)' }}>
              / {budgetLimit} CZK limit
            </span>
          </>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
        {/* Progress bar container */}
        <div style={{
          height: '8px',
          width: '100%',
          backgroundColor: 'var(--surface-3)',
          borderRadius: 'var(--radius-full)',
          overflow: 'hidden',
        }}>
          <div style={{
            height: '100%',
            width: `${Math.min(percentUsed, 100)}%`,
            backgroundColor: barColor,
            borderRadius: 'var(--radius-full)',
            transition: 'width 0.3s ease-in-out, background-color 0.3s',
          }} />
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', color: 'var(--gray-text)' }}>
          <span>Využito {percentUsed.toFixed(1)}% rozpočtu</span>
          <span>Zbývá {(Math.max(budgetLimit - monthlyUsage, 0)).toFixed(2)} CZK</span>
        </div>
      </div>
    </div>
  );
}
