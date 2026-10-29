-- manifest: Pessoa física: endereço no contato (CEP, logradouro, número, complemento, bairro, cidade, UF) para entrega e cobrança — colunas em `contacts`, espelhando `companies`. Issue #3494.

-- 9041 — endereço da pessoa física no contato (issue #3494).
--
-- `contacts` só tinha `address_book_name` (rótulo da agenda do celular, nunca
-- endereço). Entrega e cobrança precisam do endereço do titular, e hoje ele
-- morava só em `companies` (pessoa jurídica). As colunas abaixo espelham as de
-- `companies` (migration 0368/0448) para a pessoa física, com os mesmos nomes e
-- tipos, para que um mesmo código de formatação/validação sirva aos dois.
--
-- Aditiva e idempotente: `add column if not exists`. Sem backfill — quem não
-- tinha endereço segue sem. Sem CHECK de formato: CEP/UF variam por país e a
-- validação fica na borda (Zod), como em `companies`.

alter table public.contacts
  add column if not exists zip_code text,
  add column if not exists street text,
  add column if not exists number text,
  add column if not exists complement text,
  add column if not exists district text,
  add column if not exists city text,
  add column if not exists state text;

comment on column public.contacts.zip_code is
  'CEP do endereço da pessoa física (issue #3494). NULL quando não informado.';
comment on column public.contacts.street is
  'Logradouro do endereço da pessoa física (issue #3494). NULL quando não informado.';
comment on column public.contacts.number is
  'Número do endereço da pessoa física (issue #3494). NULL quando não informado.';
comment on column public.contacts.complement is
  'Complemento do endereço da pessoa física (issue #3494). NULL quando não informado.';
comment on column public.contacts.district is
  'Bairro do endereço da pessoa física (issue #3494). NULL quando não informado.';
comment on column public.contacts.city is
  'Cidade do endereço da pessoa física (issue #3494). NULL quando não informado.';
comment on column public.contacts.state is
  'UF do endereço da pessoa física (issue #3494). NULL quando não informado.';

notify pgrst, 'reload schema';