import { request } from './api.js';
import { escapeHtml as h } from './model.js';

export function createAccountUI(ctx) {
  const signedInAccount = () => !!ctx.session()?.user && ctx.session()?.authType !== 'frame';
  function tools() {
    if (!signedInAccount()) return '';
    return `<div class="account-tools"><a class="text-button" href="/privacy.html" target="_blank" rel="noopener">Privacy policy</a>${ctx.session().role === 'admin' && ctx.session().household ? ctx.button('Transfer household ownership', 'transfer-ownership', 'text-button') : ''}${ctx.button('Delete my account', 'delete-account', 'text-button danger-text')}</div>`;
  }
  async function action(name) {
    if (!['delete-account', 'transfer-ownership'].includes(name)) return false;
    if (!signedInAccount()) return true;
    const started = ctx.epoch();
    if (name === 'transfer-ownership') {
      if (ctx.session().role !== 'admin') return true;
      await ctx.reloadSetup();
      if (started !== ctx.epoch()) return true;
      const members = ctx.members().filter(member => member.role === 'member' && member.id !== ctx.session().user.id);
      ctx.openDialog('Transfer household ownership', `<div class="form-stack"><p>The selected adult becomes the administrator. You stay a family member. Ask them to review task and device controls after the transfer.</p>${members.length ? `<label class="field"><span>New administrator</span><select name="userId" aria-label="New administrator" required><option value="">Choose an existing adult</option>${members.map(member => `<option value="${h(member.id)}">${h(member.name || member.email || 'Family member')}</option>`).join('')}</select></label>${ctx.field('Type TRANSFER to confirm', 'confirmation', '', { max: 8 })}<button type="submit" class="button">Transfer ownership</button>` : '<p class="status-note">Invite another adult and have them join before transferring ownership.</p>'}</div>`, async (form, element) => {
        if (form.get('confirmation') !== 'TRANSFER') throw new Error('Type TRANSFER exactly to confirm.');
        try { await request('/api/account/transfer-ownership', { method: 'POST', body: { userId: form.get('userId') } }); }
        catch (error) {
          if (!error.status || error.status >= 500) { element.dataset.reviewRequired = 'true'; throw new Error('The transfer may have completed. Close this dialog and refresh your account before trying again.'); }
          throw error;
        }
        if (started !== ctx.epoch()) return;
        ctx.dialog.close(); await ctx.reboot(); ctx.toast('Household ownership transferred.');
      });
      return true;
    }
    ctx.openDialog('Delete your Family Frame account', `<div class="form-stack"><p>This permanently deletes your sign-in and personal settings. Shared family history may remain with your identity removed. If you own this household, transfer ownership first when other members remain.</p><p>Household deletion requires all Internet sessions ended with blocking confirmed and managed devices safely unenrolled. It cannot remove a live firewall policy.</p><a class="text-button" href="/privacy.html" target="_blank" rel="noopener">Read the privacy policy</a>${ctx.field('Current password', 'password', '', { type: 'password', autocomplete: 'current-password', max: 1024 })}${ctx.field('Type DELETE MY ACCOUNT to confirm', 'confirmation', '', { max: 17 })}<button type="submit" class="button button-danger">Permanently delete my account</button></div>`, async (form, element) => {
      if (form.get('confirmation') !== 'DELETE MY ACCOUNT') throw new Error('Type DELETE MY ACCOUNT exactly to confirm.');
      const password = form.get('password');
      element.querySelector('[name="password"]').value = '';
      let result;
      try { result = await request('/api/account/delete', { method: 'POST', timeoutMs: 65000, body: { password, confirmation: 'DELETE MY ACCOUNT' } }); }
      catch (error) {
        if (started !== ctx.epoch()) return;
        if (error.code === 'ownership_transfer_required') throw new Error('Transfer ownership to another adult from Setup, then delete your account.');
        if (!error.status || error.status >= 500) { element.dataset.reviewRequired = 'true'; throw new Error('Deletion could not be confirmed. Close this dialog, sign in again, then retry Delete my account. It is also available before joining a household.'); }
        throw error;
      }
      if (started !== ctx.epoch()) return;
      if (result?.deleted !== true) throw new Error('Deletion was not confirmed. Sign in again and retry.');
      ctx.dialog.close(); await ctx.deleted();
    });
    return true;
  }
  return { tools, action };
}
