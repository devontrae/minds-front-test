import {
  ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, EventEmitter, Input, Renderer,
  ViewChild
} from '@angular/core';

import { Client } from '../../../services/api/client';
import { Session } from '../../../services/session';
import { Upload } from '../../../services/api/upload';
import { AttachmentService } from '../../../services/attachment';
import { Textarea } from '../../../common/components/editors/textarea.component';
import { SocketsService } from '../../../services/sockets';

@Component({
  moduleId: module.id,
  selector: 'minds-comments',
  inputs: ['_object : object', '_reversed : reversed', 'limit', 'focusOnInit', 'scrollable'],
  templateUrl: 'list.component.html',
  providers: [
    {
      provide: AttachmentService,
      useFactory: AttachmentService._,
      deps: [Session, Client, Upload]
    }
  ],
  changeDetection: ChangeDetectionStrategy.OnPush
})

export class CommentsListComponent {

  minds;
  object;
  guid: string = '';
  parent: any;
  comments: Array<any> = [];
  content = '';
  reversed: boolean = false;

  focusOnInit: boolean = false;
  scrollable: boolean = false;
  @ViewChild('message') textareaControl: Textarea;
  @ViewChild('scrollArea') scrollView: ElementRef;

  editing: boolean = false;

  showModal: boolean = false;

  limit: number = 12;
  offset: string = '';
  inProgress: boolean = false;
  canPost: boolean = true;
  triedToPost: boolean = false;
  moreData: boolean = false;
  loaded: boolean = false;

  socketRoomName: string;
  socketSubscriptions: any = {
    comment: null
  };

  error: string;

  @Input() conversation: boolean = false;
  @Input() readonly: boolean = false;

  commentsScrollEmitter: EventEmitter<any> = new EventEmitter();

  private autoloadBlocked = false;

  private overscrollTimer;
  private overscrollAmount = 0;

  constructor(
    public session: Session,
    public client: Client,
    public attachment: AttachmentService,
    public sockets: SocketsService,
    private renderer: Renderer,
    private cd: ChangeDetectorRef
  ) {
    this.minds = window.Minds;
  }

  set _object(value: any) {
    this.object = value;
    this.guid = this.object.guid;
    if (this.object.entity_guid)
      this.guid = this.object.entity_guid;
    this.parent = this.object;
  }

  set _reversed(value: boolean) {
    if (value)
      this.reversed = true;
    else
      this.reversed = false;
  }

  ngOnInit() {
    this.load(true);
    this.listen();
  }

  load(refresh = false) {
    if (refresh) {
      this.offset = '';
      this.moreData = true;
      this.comments = [];

      if (this.socketRoomName) {
        this.sockets.leave(this.socketRoomName);
      }
      this.socketRoomName = void 0;
    }

    if (this.inProgress) {
      return;
    }

    this.error = '';
    this.inProgress = true;

    this.detectChanges();

    this.client.get('api/v1/comments/' + this.guid, { 
      limit: refresh ? 5 : this.limit, 
      offset: this.offset, 
      reversed: false 
    })
      .then((response: any) => {

        if (!this.socketRoomName && response.socketRoomName) {
          this.socketRoomName = response.socketRoomName;
          this.joinSocketRoom();
        }

        this.loaded = true;
        this.inProgress = false;
        this.moreData = true;

        if (!response.comments) {
          this.moreData = false;
          this.detectChanges();

          return false;
        }

        this.comments = response.comments.concat(this.comments);
        this.detectChanges();

        if (refresh) {
          this.commentsScrollEmitter.emit('bottom');
        }

        if (this.offset && this.scrollView) {
          let el = this.scrollView.nativeElement;
          let scrollTop = el.scrollTop;
          let scrollHeight = el.scrollHeight;

          this.detectChanges();
          el.scrollTop = scrollTop + el.scrollHeight - scrollHeight;
        }

        this.offset = response['load-previous'];

        if (
          !this.offset ||
          this.offset === null 
          //||
          //response.comments.length < (this.limit - 1)
        ) {
          this.moreData = false;
        }

        this.detectChanges();
      })
      .catch((e) => {
        this.inProgress = false;
        this.error = (e && e.message) || 'There was an error';
        this.detectChanges();
      });
  }

  autoloadPrevious() {
    if (!this.moreData || this.autoloadBlocked) {
      return;
    }

    this.cancelOverscroll();

    this.autoloadBlocked = true;
    setTimeout(() => {
      this.autoloadBlocked = false;
    }, 1000);

    this.load();
  }

  overscrollHandler({ deltaY }) {
    this.cancelOverscroll();

    if (this.autoloadBlocked) {
      this.overscrollAmount = 0;
      return;
    }

    this.overscrollAmount += deltaY;

    this.overscrollTimer = setTimeout(() => {
      if (this.overscrollAmount < -75) { //75px
        this.autoloadPrevious();
      }

      this.overscrollAmount = 0;
    }, 250); // in 250ms
  }

  cancelOverscroll() {
    if (this.overscrollTimer) {
      clearTimeout(this.overscrollTimer);
    }
  }

  joinSocketRoom() {
    if (this.socketRoomName) {
      this.sockets.join(this.socketRoomName);
    }
  }

  ngAfterViewInit() {
    if (this.focusOnInit) {
      this.textareaControl.focus();
    }
  }

  ngOnDestroy() {
    this.cancelOverscroll();

    if (this.socketRoomName && !this.conversation) {
      this.sockets.leave(this.socketRoomName);
    }

    for (let sub in this.socketSubscriptions) {
      if (this.socketSubscriptions[sub]) {
        this.socketSubscriptions[sub].unsubscribe();
      }
    }
  }

  listen() {
    this.socketSubscriptions.comment = this.sockets.subscribe('comment', (parent_guid, owner_guid, guid) => {
      if (parent_guid !== this.guid) {
        return;
      }

      if (this.session.isLoggedIn() && owner_guid === this.session.getLoggedInUser().guid) {
        return;
      }

      this.client.get('api/v1/comments/' + this.guid, { limit: 1, offset: guid, reversed: false })
        .then((response: any) => {
          if (!response.comments || response.comments.length === 0) {
            return;
          }

          // if the list is scrolled to the bottom
          let scrolledToBottom = this.scrollView.nativeElement.scrollTop + this.scrollView.nativeElement.clientHeight >= this.scrollView.nativeElement.scrollHeight;

          this.comments.push(response.comments[0]);
          this.detectChanges();

          if (scrolledToBottom) {
            this.commentsScrollEmitter.emit('bottom');
          }
        });
    });
  }

  postEnabled() {
    return !this.inProgress && this.canPost && (this.content || this.attachment.has());
  }

  async post(e) {
    e.preventDefault();

    if (!this.content && !this.attachment.has()) {
      return;
    }

    if (this.inProgress || !this.canPost) {
      this.triedToPost = true;
      this.detectChanges();

      return;
    }

    let data = this.attachment.exportMeta();
    data['comment'] = this.content;

    let newLength = this.comments.push({ // Optimistic
      description: this.content,
      guid: 0,
      ownerObj: this.session.getLoggedInUser(),
      owner_guid: this.session.getLoggedInUser().guid,
      time_created: Date.now() / 1000,
      type: 'comment'
    }), currentIndex = newLength - 1;

    this.attachment.reset();
    this.content = '';

    this.detectChanges();

    this.commentsScrollEmitter.emit('bottom');

    try {
      let response: any = await this.client.post('api/v1/comments/' + this.guid, data);
      this.comments[currentIndex] = response.comment;
    } catch (e) {
      this.comments[currentIndex].error = (e && e.message) || 'There was an error';
      console.error('Error posting', e);
    }

    this.detectChanges();

    this.commentsScrollEmitter.emit('bottom');
  }

  isLoggedIn() {
    if (!this.session.isLoggedIn()) {
      this.showModal = true;
      this.detectChanges();
    }
  }


  delete(index: number) {
    this.comments.splice(index, 1);
    this.detectChanges();
  }

  edited(index: number, $event) {
    this.comments[index] = $event.comment;
  }

  resetPreview() {
    this.canPost = true;
    this.triedToPost = false;
    this.attachment.resetRich();
  }

  uploadAttachment(file: HTMLInputElement, e?: any) {
    this.canPost = false;
    this.triedToPost = false;

    this.attachment.setHidden(true);
    this.attachment.setContainer(this.object);
    this.attachment.upload(file)
      .then(guid => {
        this.canPost = true;
        this.triedToPost = false;
        file.value = null;
      })
      .catch(e => {
        console.error(e);
        this.canPost = true;
        this.triedToPost = false;
        file.value = null;
      });

    this.detectChanges();
  }

  removeAttachment(file: HTMLInputElement) {
    this.canPost = false;
    this.triedToPost = false;

    this.attachment.remove(file).then(() => {
      this.canPost = true;
      this.triedToPost = false;
      file.value = '';
    }).catch(e => {
      console.error(e);
      this.canPost = true;
      this.triedToPost = false;
    });

    this.detectChanges();
  }

  async getPostPreview(message) {
    if (!message) {
      return;
    }

    this.attachment.preview(message, this.detectChanges);
  }

  reply(comment: any) {
    if (!comment || !comment.ownerObj) {
      return;
    }

    const username = comment.ownerObj.username;

    this.content = `@${username} ${this.content}`;
    this.detectChanges();

    setTimeout(() => {
      this.textareaControl.focus();
    }, 50);
  }

  getAvatar() {
    if(this.session.isLoggedIn()) {
      return `${this.minds.cdn_url}icon/${this.session.getLoggedInUser().guid}/small/${this.session.getLoggedInUser().icontime}`;
    } else {
      return `${this.minds.cdn_assets_url}assets/avatars/default-small.png`
    }
  }

  detectChanges = () => {
    this.cd.markForCheck();
    this.cd.detectChanges();
  }
}
