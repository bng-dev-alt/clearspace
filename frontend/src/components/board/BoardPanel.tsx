import React from 'react';

interface BoardPanelProps {
  children: React.ReactNode;
  projectName: string;
  /** RUN 11: the project name is the page H1 now; the panel repeats it only when the project header is collapsed. */
  showTitle?: boolean;
}

export default function BoardPanel({ children, projectName, showTitle = true }: BoardPanelProps) {
  return (
    <div className="board-panel-card">
      {showTitle && (
        <div className="board-panel-header">
          <div className="panel-header-left">
            <h2 className="panel-title">{projectName}</h2>
          </div>
        </div>
      )}

      <main className="board-container" data-testid="board-container">
        {children}
      </main>
    </div>
  );
}
