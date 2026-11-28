'use client';

import type { ReactNode } from 'react';
import { css } from '@emotion/react';
import styled from '@emotion/styled';

export const StyledHeroBanner = styled.section`
  background: linear-gradient(135deg, #1b3f9c 0%, #2b5be0 100%);
  color: #ffffff;
  border-radius: 14px;
  padding: 24px 28px;
  display: flex;
  flex-direction: column;
  gap: 8px;

  @media (max-width: 768px) {
    padding: 18px 20px;
  }
`;

export const StyledObjectSurface = styled.div({
  backgroundColor: '#ffffff',
  border: '1px solid #dce3f0',
  borderRadius: 12,
  padding: 20,
  transition: 'border-color 140ms ease',
  '&:hover': {
    borderColor: '#1f4fd8',
  },
});

export const StyledStatusPill = styled.span<{ active?: boolean }>`
  display: inline-flex;
  align-items: center;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  background-color: ${(props) => (props.active ? '#e5edff' : '#eef1f6')};
  color: ${(props) => (props.active ? '#1f4fd8' : '#4b5563')};
`;

const calloutBase = css`
  border-left: 4px solid #1f4fd8;
  background-color: #f0f5ff;
  border-radius: 8px;
  padding: 14px 16px;
  color: #162447;
`;

const calloutHighlighted = css({
  borderLeftColor: '#6c2bd9',
  backgroundColor: '#f5f0ff',
});

export function EmotionCssCallout({
  title,
  highlighted = false,
  children,
}: {
  title: string;
  highlighted?: boolean;
  children: ReactNode;
}) {
  return (
    <aside css={[calloutBase, highlighted && calloutHighlighted]}>
      <strong
        css={css`
          display: block;
          font-size: 14px;
          margin-bottom: 4px;
        `}
      >
        {title}
      </strong>
      <div css={{ fontSize: 13, lineHeight: 1.5 }}>{children}</div>
    </aside>
  );
}
