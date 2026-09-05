/**
 * A labelled form control that shows the server's own error message.
 *
 * Validation messages come from the shared zod schemas, so what the browser says
 * about an invalid email and what the server says are the same sentence. When the
 * server rejects a submission, its field errors are handed straight to these
 * components rather than being translated into something vaguer.
 */
import { useId } from 'react';
import type { ReactNode, SelectHTMLAttributes, InputHTMLAttributes, TextareaHTMLAttributes } from 'react';

type FieldProps = {
  label: string;
  htmlFor?: string;
  required?: boolean;
  hint?: string;
  error?: string | undefined;
  /** id of the element describing this field, wired to aria-describedby. */
  describedBy?: string;
  children: ReactNode;
};

export function Field({ label, htmlFor, required, hint, error, describedBy, children }: FieldProps) {
  const showError = error !== undefined && error !== '';

  return (
    <div className="field">
      <label className="field__label" htmlFor={htmlFor}>
        {label}
        {required === true && <span className="field__required" aria-hidden="true">*</span>}
      </label>
      {children}
      {showError ? (
        <span className="field__error" id={describedBy} role="alert">{error}</span>
      ) : (
        hint !== undefined && <span className="field__hint" id={describedBy}>{hint}</span>
      )}
    </div>
  );
}

type TextFieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  error?: string | undefined;
  hint?: string;
};

export function TextField({ label, error, hint, required, ...inputProps }: TextFieldProps) {
  // useId rather than the label text: two fields sharing a label on one page
  // produced the same DOM id, and every <label for> then pointed at the first.
  const generated = useId();
  const id = inputProps.id ?? generated;
  const describedBy = `${id}-message`;
  const hasMessage = (error !== undefined && error !== '') || hint !== undefined;

  return (
    <Field label={label} htmlFor={id} required={required} hint={hint} error={error} describedBy={describedBy}>
      <input
        {...inputProps}
        id={id}
        className="input"
        aria-invalid={error !== undefined && error !== ''}
        aria-describedby={hasMessage ? describedBy : undefined}
      />
    </Field>
  );
}

type SelectFieldProps = SelectHTMLAttributes<HTMLSelectElement> & {
  label: string;
  error?: string | undefined;
  hint?: string;
  options: Array<{ value: string | number; label: string }>;
  placeholder?: string;
};

export function SelectField({
  label, error, hint, required, options, placeholder, ...selectProps
}: SelectFieldProps) {
  const generated = useId();
  const id = selectProps.id ?? generated;
  const describedBy = `${id}-message`;
  const hasMessage = (error !== undefined && error !== '') || hint !== undefined;

  return (
    <Field label={label} htmlFor={id} required={required} hint={hint} error={error} describedBy={describedBy}>
      <select
        {...selectProps}
        id={id}
        className="select"
        aria-invalid={error !== undefined && error !== ''}
        aria-describedby={hasMessage ? describedBy : undefined}
      >
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </Field>
  );
}

type TextAreaFieldProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label: string;
  error?: string | undefined;
  hint?: string;
};

export function TextAreaField({ label, error, hint, required, ...props }: TextAreaFieldProps) {
  const generated = useId();
  const id = props.id ?? generated;
  const describedBy = `${id}-message`;
  const hasMessage = (error !== undefined && error !== '') || hint !== undefined;

  return (
    <Field label={label} htmlFor={id} required={required} hint={hint} error={error} describedBy={describedBy}>
      <textarea
        {...props}
        id={id}
        className="textarea"
        aria-invalid={error !== undefined && error !== ''}
        aria-describedby={hasMessage ? describedBy : undefined}
      />
    </Field>
  );
}
