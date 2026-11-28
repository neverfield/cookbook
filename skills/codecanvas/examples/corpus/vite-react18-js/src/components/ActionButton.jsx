import React from 'react';
import styles from './ActionButton.module.css';
import { joinClasses } from '../utils/classNames.js';

const VARIANT_STYLES = {
  primary: styles.primary,
  secondary: styles.secondary,
  ghost: styles.ghost,
};

export const ActionButton = React.forwardRef(function ActionButton(
  {
    variant = 'primary',
    size = 'md',
    disabled = false,
    className = '',
    type = 'button',
    children,
    ...rest
  },
  ref
) {
  const computedClassName = joinClasses(
    styles.button,
    VARIANT_STYLES[variant] || styles.primary,
    size === 'sm' && styles.compact,
    disabled && styles.disabled,
    className
  );

  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled}
      className={computedClassName}
      {...rest}
    >
      {children}
    </button>
  );
});
