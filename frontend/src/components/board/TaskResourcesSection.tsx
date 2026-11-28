'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useConfirm } from '../ui/useConfirm';
import { Paperclip, Upload, Trash2, Download, Eye, FileText, Image as ImageIcon, FileSpreadsheet, FileCode, X, Sparkles } from 'lucide-react';
import { resourceService, resourceErrorMessage, ResourceUploadError } from '../../services/resourceService';
import { TaskResource } from '../../types/kanban';
import ResourceAiModal from './ResourceAiModal';

interface TaskResourcesSectionProps {
  taskId: string;
  cardTitle?: string;
  uploadedBy?: string;
  onAddSubtaskToChecklist?: (text: string) => void;
}

export default function TaskResourcesSection({
  taskId,
  cardTitle = 'Úkol',
  uploadedBy = 'Uživatel',
  onAddSubtaskToChecklist,
}: TaskResourcesSectionProps) {
  const [ask, confirmDialog] = useConfirm();
  const [resources, setResources] = useState<TaskResource[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadErrors, setUploadErrors] = useState<string[]>([]);
  const [previewResource, setPreviewResource] = useState<TaskResource | null>(null);
  const [aiResource, setAiResource] = useState<TaskResource | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let isMounted = true;
    async function loadResources() {
      setIsLoading(true);
      try {
        const list = await resourceService.fetchTaskResources(taskId);
        if (isMounted) setResources(list);
      } catch (err) {
        console.warn('Could not load resources:', err);
      } finally {
        if (isMounted) setIsLoading(false);
      }
    }
    loadResources();
    return () => {
      isMounted = false;
    };
  }, [taskId]);

  const handleFileUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setIsUploading(true);
    setUploadErrors([]);

    // One bad file must not hide the others: every file is tried, each failure is reported with its own reason.
    const failures: string[] = [];
    for (const file of Array.from(files)) {
      try {
        const newRes = await resourceService.uploadResource(taskId, file, uploadedBy);
        setResources((prev) => [newRes, ...prev]);
      } catch (err) {
        failures.push(`${file.name}: ${err instanceof ResourceUploadError ? err.message : resourceErrorMessage('unknown')}`);
      }
    }
    setUploadErrors(failures);
    setIsUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleDelete = async (res: TaskResource) => {
    if (!(await ask({ title: 'Smazat přílohu?', message: `Příloha „${res.filename}“ se smaže z úkolu i z úložiště. Tuto akci nelze vrátit.`, confirmLabel: 'Smazat', danger: true }))) return;
    const success = await resourceService.deleteResource(res.id, res.storagePath);
    if (success) {
      setResources((prev) => prev.filter((r) => r.id !== res.id));
      if (previewResource?.id === res.id) setPreviewResource(null);
    } else {
      setUploadErrors(['Přílohu se nepodařilo smazat. Zkuste to prosím znovu.']);
    }
  };

  const getFileIcon = (mimeType: string, filename: string) => {
    const ext = filename.split('.').pop()?.toLowerCase();
    if (mimeType.startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp'].includes(ext || '')) {
      return <ImageIcon size={16} style={{ color: 'var(--blue-primary)' }} />;
    }
    if (['csv', 'xlsx', 'xls'].includes(ext || '') || mimeType.includes('spreadsheet') || mimeType.includes('csv')) {
      return <FileSpreadsheet size={16} style={{ color: '#107c41' }} />;
    }
    if (['md', 'txt', 'json', 'js', 'ts'].includes(ext || '')) {
      return <FileCode size={16} style={{ color: 'var(--purple-secondary)' }} />;
    }
    return <FileText size={16} style={{ color: 'var(--gray-text)' }} />;
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    handleFileUpload(e.dataTransfer.files);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }} data-testid="task-resources-section">
      {confirmDialog}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 className="drawer-section-title" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', margin: 0 }}>
          <Paperclip size={14} /> Přílohy ({resources.length})
        </h3>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.35rem',
            padding: '0.35rem 0.65rem',
            backgroundColor: 'var(--bg-column)',
            border: '1px solid var(--border-color)',
            borderRadius: '6px',
            fontSize: '0.75rem',
            fontWeight: 600,
            cursor: 'pointer',
            color: 'var(--dark-navy)',
          }}
          data-testid="upload-resource-btn"
        >
          <Upload size={13} />
          Nahrát zdroj
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => handleFileUpload(e.target.files)}
          data-testid="resource-file-input"
        />
      </div>

      {/* Drag and Drop Zone */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        style={{
          border: isDragOver ? '2px dashed var(--purple-secondary)' : '1px dashed var(--border-color)',
          backgroundColor: isDragOver ? 'rgba(117, 57, 145, 0.05)' : 'var(--bg-column)',
          borderRadius: '8px',
          padding: '0.75rem',
          textAlign: 'center',
          transition: 'all 0.2s ease',
          cursor: 'pointer',
        }}
        onClick={() => fileInputRef.current?.click()}
        data-testid="resource-dropzone"
      >
        <p style={{ fontSize: '0.75rem', color: 'var(--gray-text)', margin: 0 }}>
          {isUploading
            ? 'Nahrávání...'
            : isDragOver
            ? 'Pusťte soubory zde pro nahrání'
            : 'Přetáhněte soubory sem (PDF, DOCX, PNG, JPG, MD, CSV; do 10 MB) nebo klikněte'}
        </p>
      </div>

      {uploadErrors.length > 0 && (
        <div role="alert" data-testid="resource-upload-error" style={{ fontSize: '0.75rem', color: 'var(--danger)', display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
          {uploadErrors.map((m, i) => (
            <span key={i}>{m}</span>
          ))}
        </div>
      )}

      {/* Resource List */}
      {isLoading ? (
        <p style={{ fontSize: '0.75rem', color: 'var(--gray-text)', fontStyle: 'italic' }}>Načítání zdrojů...</p>
      ) : resources.length === 0 ? (
        <p style={{ fontSize: '0.75rem', color: 'var(--gray-text)', fontStyle: 'italic' }}>Zatím žádné nahrané zdroje.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }} data-testid="resource-list">
          {resources.map((res) => (
            <div
              key={res.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '0.5rem 0.75rem',
                backgroundColor: 'var(--surface-1)',
                border: '1px solid var(--border-color)',
                borderRadius: '6px',
              }}
              data-testid={`resource-item-${res.id}`}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', overflow: 'hidden' }}>
                {getFileIcon(res.mimeType, res.filename)}
                <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                  <span
                    style={{
                      fontSize: '0.8rem',
                      fontWeight: 600,
                      color: 'var(--dark-navy)',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {res.filename}
                  </span>
                  <span style={{ fontSize: '0.7rem', color: 'var(--gray-text)' }}>
                    {formatFileSize(res.size)} • {res.uploadedBy}
                  </span>
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                {res.downloadUrl && (
                  <>
                    <button
                      type="button"
                      onClick={() => setPreviewResource(res)}
                      title="Náhled"
                      style={{
                        background: 'none',
                        border: 'none',
                        padding: '0.25rem',
                        cursor: 'pointer',
                        color: 'var(--gray-text)',
                      }}
                      data-testid={`preview-resource-${res.id}`}
                    >
                      <Eye size={14} />
                    </button>
                    <a
                      href={res.downloadUrl}
                      download={res.filename}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Stáhnout"
                      style={{
                        padding: '0.25rem',
                        color: 'var(--gray-text)',
                        display: 'flex',
                        alignItems: 'center',
                      }}
                      data-testid={`download-resource-${res.id}`}
                    >
                      <Download size={14} />
                    </a>
                    <button
                      type="button"
                      onClick={() => setAiResource(res)}
                      title="AI Analýza podkladu"
                      style={{
                        background: 'none',
                        border: 'none',
                        padding: '0.25rem',
                        cursor: 'pointer',
                        color: 'var(--purple-secondary)',
                      }}
                      data-testid={`ai-analyze-resource-${res.id}`}
                    >
                      <Sparkles size={14} />
                    </button>
                  </>
                )}
                <button
                  type="button"
                  onClick={() => handleDelete(res)}
                  title="Smazat"
                  style={{
                    background: 'none',
                    border: 'none',
                    padding: '0.25rem',
                    cursor: 'pointer',
                    color: 'var(--danger)',
                  }}
                  data-testid={`delete-resource-${res.id}`}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Preview Modal */}
      {previewResource && (
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
            padding: '1rem',
          }}
          onClick={() => setPreviewResource(null)}
          data-testid="resource-preview-modal"
        >
          <div
            style={{
              backgroundColor: 'var(--bg-page)',
              borderRadius: '12px',
              maxWidth: '800px',
              width: '100%',
              maxHeight: '90vh',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              boxShadow: 'var(--shadow-xl)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '0.85rem 1.25rem',
                borderBottom: '1px solid var(--border-color)',
              }}
            >
              <span style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--dark-navy)' }}>
                {previewResource.filename}
              </span>
              <button
                type="button"
                onClick={() => setPreviewResource(null)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--gray-text)' }}
              >
                <X size={18} />
              </button>
            </div>
            <div
              style={{
                padding: '1.25rem',
                overflowY: 'auto',
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                minHeight: '200px',
              }}
            >
              {previewResource.mimeType.startsWith('image/') ||
              ['png', 'jpg', 'jpeg', 'webp'].includes(previewResource.filename.split('.').pop()?.toLowerCase() || '') ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={previewResource.downloadUrl}
                  alt={previewResource.filename}
                  style={{ maxWidth: '100%', maxHeight: '70vh', objectFit: 'contain', borderRadius: '6px' }}
                />
              ) : (
                <div style={{ textAlign: 'center', color: 'var(--gray-text)' }}>
                  <FileText size={48} style={{ marginBottom: '0.5rem', color: 'var(--purple-secondary)' }} />
                  <p style={{ margin: 0, fontSize: '0.85rem' }}>Náhled není dostupný pro tento typ souboru.</p>
                  <a
                    href={previewResource.downloadUrl}
                    download={previewResource.filename}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      display: 'inline-block',
                      marginTop: '0.75rem',
                      color: 'var(--purple-secondary)',
                      fontWeight: 600,
                      fontSize: '0.85rem',
                    }}
                  >
                    Stáhnout soubor
                  </a>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Resource AI Analysis Modal */}
      {aiResource && (
        <ResourceAiModal
          isOpen={!!aiResource}
          onClose={() => setAiResource(null)}
          resource={aiResource}
          cardTitle={cardTitle}
          onAddSubtaskToChecklist={onAddSubtaskToChecklist}
        />
      )}
    </div>
  );
}
