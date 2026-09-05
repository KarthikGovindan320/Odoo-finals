/**
 * A labelled form control that shows the server's own error message.
 *
 * Validation messages come from the shared zod schemas, so what the browser says
 * about an invalid email and what the server says are the same sentence. When the
 * server rejects a submission, its field errors are handed straight to these
 * components rather than being translated into something vaguer.
 */
import type { ReactNode, SelectHTMLAttributes, InputHTMLAttributes, TextareaHTMLAttributes } from 'react';

type FieldProps = {
  label: string;
  htmlFor?: string;
  required?: boolean;
  hint?: string;
  error?: string | undefined;
  children: ReactNode;
};

export function Field({ label, htmlFor, required, hint, error, children }: FieldProps) {
  return (
    <div className="field">
      <label className="field__label" htmlFor={htmlFor}>
        {label}
        {required === true && <span className="field__required" aria-hidden="true">*</span>}
      </label>
      {children}
      {error !== undefined && error !== '' ? (
        <span className="field__error" role="alert">{error}</span>
      ) : (
        hint !== undefined && <span className="field__hint">{hint}</span>
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
  const id = inputProps.name ?? label.replace(/\s+/g, '-').toLowerCase();
  return (
    <Field label={label} htmlFor={id} required={required} hint={hint} error={error}>
      <input
        {...inputProps}
        id={id}
        className="input"
        aria-invalid={error !== undefined && error !== ''}
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
  const id = selectProps.name ?? label.replace(/\s+/g, '-').toLowerCase();
  return (
    <Field label={label} htmlFor={id} required={required} hint={hint} error={error}>
      <select
        {...selectProps}
        id={id}
        className="select"
        aria-invalid={error !== undefined && error !== ''}
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
  const id = props.name ?? label.replace(/\s+/g, '-').toLowerCase();
  return (
    <Field label={label} htmlFor={id} required={required} hint={hint} error={error}>
      <textarea {...props} id={id} className="textarea" aria-invalid={error !== undefined && error !== ''} />
    </Field>
  );
}
